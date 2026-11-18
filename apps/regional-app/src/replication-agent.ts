/**
 * Drives the simulated database through time: synthetic writes on the primary, log shipping to replicas, and
 * promotions (catch up, switch roles, then notify the sentry through the replication webhook).
 */
import type { ReplicationWebhookEvent } from '@failover-sentry/contracts';
import type { ChaosController } from './chaos.js';
import type { PeerDatabaseStatus, SimulatedDatabase } from './database.js';
import type { Logger } from './logger.js';
import type { Peer, PeerClient } from './peer-client.js';
import type { WebhookSender } from './webhook-sender.js';

export interface ReplicationAgentOptions {
  regionId: string;
  peers: readonly Peer[];
  /** Role-switch time of a planned promotion once caught up. */
  plannedSwitchDelayMs: number;
  /** Role-switch time of a forced promotion. */
  forcedSwitchDelayMs: number;
  /** A planned promotion fails when no peer has answered for this long. */
  plannedPeerTimeoutMs: number;
  tickIntervalMs: number;
}

export class ReplicationAgent {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly pendingWebhooks = new Set<Promise<boolean>>();
  /** Peers whose last poll failed, with the error: logged when it changes, not on every tick. */
  private readonly unreachablePeers = new Map<string, string>();

  constructor(
    private readonly db: SimulatedDatabase,
    private readonly chaos: ChaosController,
    private readonly peerClient: PeerClient,
    private readonly webhook: WebhookSender | null,
    private readonly options: ReplicationAgentOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.ticking) {
        return; // A slow peer must not pile up overlapping ticks.
      }
      this.ticking = true;
      this.tick()
        .catch((error: unknown) =>
          this.logger.error({ err: (error as Error).message }, 'replication tick failed'),
        )
        .finally(() => {
          this.ticking = false;
        });
    }, this.options.tickIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.pendingWebhooks]);
  }

  /** One step of simulated time. Public so tests can drive it. */
  async tick(): Promise<void> {
    if (this.chaos.isDown) {
      return; // A dead region neither writes nor talks to its peers.
    }
    this.db.writeTick();
    const statuses = await this.pollPeers();
    const factor = this.chaos.slowFactor === 1 ? 1 : 1 / this.chaos.slowFactor;
    for (const status of statuses) {
      const note = this.db.observePrimary(status, factor);
      if (note) {
        this.logger.warn({ peer: status.regionId }, note);
      }
    }
    await this.drivePromotion(statuses);
  }

  /** Waits for in-flight webhook deliveries (tests and graceful shutdown). */
  async flushWebhooks(): Promise<void> {
    await Promise.allSettled([...this.pendingWebhooks]);
  }

  private async pollPeers(): Promise<PeerDatabaseStatus[]> {
    const results = await Promise.allSettled(
      this.options.peers.map((peer) => this.peerClient.getStatus(peer)),
    );
    const reachable: PeerDatabaseStatus[] = [];
    results.forEach((result, index) => {
      const peer = this.options.peers[index];
      if (!peer) {
        return;
      }
      if (result.status === 'fulfilled') {
        reachable.push(result.value);
        if (this.unreachablePeers.delete(peer.regionId)) {
          this.logger.info({ peer: peer.regionId }, 'peer reachable again');
        }
        return;
      }
      const reason = result.reason as Error;
      const error = reason.name === 'TimeoutError' ? 'timed out' : reason.message;
      if (this.unreachablePeers.get(peer.regionId) !== error) {
        this.unreachablePeers.set(peer.regionId, error);
        this.logger.warn({ peer: peer.regionId, err: error }, 'peer unreachable');
      }
    });
    return reachable;
  }

  private async drivePromotion(reachable: PeerDatabaseStatus[]): Promise<void> {
    const active = this.db.activePromotion;
    if (!active) {
      return;
    }
    const replication = this.chaos.get().replication;
    if (replication === 'stalled') {
      return; // Stuck: the sentry's durable timeout has to notice.
    }
    if (replication === 'fail') {
      const failed = this.db.failPromotion('simulated replication failure (chaos)');
      if (failed) {
        this.notify('replication.promotion.failed', failed.error);
      }
      return;
    }

    if (active.mode === 'forced') {
      this.db.scheduleForcedSwitch(this.options.forcedSwitchDelayMs * this.chaos.slowFactor);
    } else if (active.mode === 'planned' && active.status === 'catching-up') {
      await this.catchUpForPlannedPromotion(active.epoch, active.failoverId, reachable);
    }

    if (this.db.switchDue()) {
      const result = this.db.completePromotion();
      if (result) {
        this.logger.info(
          { epoch: this.db.currentEpoch, dataLossTransactions: result.dataLossTransactions },
          'promotion completed: this node is primary',
        );
        this.notify('replication.promotion.completed', null, result.dataLossTransactions);
      }
    }
  }

  private async catchUpForPlannedPromotion(
    epoch: number,
    failoverId: string,
    reachable: PeerDatabaseStatus[],
  ): Promise<void> {
    if (reachable.length === 0) {
      const age = this.db.promotionAgeMs() ?? 0;
      if (age > this.options.plannedPeerTimeoutMs) {
        const errors = [...this.unreachablePeers].map(([peer, error]) => `${peer}: ${error}`).join('; ');
        const failed = this.db.failPromotion(
          `planned promotion needs the current primary, which is unreachable${errors ? ` (${errors})` : ''}; use a forced failover`,
        );
        if (failed) {
          this.notify('replication.promotion.failed', failed.error);
        }
      }
      return;
    }
    // A planned failover fences the old primary before switching roles (the sentry normally did already).
    const unfenced = reachable.filter((peer) => peer.role === 'primary' && peer.epoch < epoch);
    for (const peer of unfenced) {
      const target = this.options.peers.find((candidate) => candidate.regionId === peer.regionId);
      if (target) {
        await this.peerClient
          .demote(target, { epoch, failoverId, reason: `planned promotion of ${this.options.regionId}` })
          .catch((error: unknown) =>
            this.logger.warn(
              { peer: peer.regionId, err: (error as Error).message },
              'could not fence old primary',
            ),
          );
      }
    }
    if (unfenced.length > 0) {
      return; // Catch up from the next poll, once the old primary has stopped writing.
    }
    const finalLsn = Math.max(...reachable.map((peer) => peer.lsn));
    this.db.catchUpWith(finalLsn);
    if (this.db.isCaughtUpWith(finalLsn)) {
      this.db.beginSwitch(this.options.plannedSwitchDelayMs * this.chaos.slowFactor);
    }
  }

  private notify(
    type: ReplicationWebhookEvent['type'],
    error: string | null,
    dataLossTransactions = 0,
  ): void {
    const snapshot = this.db.snapshot();
    const promotion = snapshot.promotion;
    if (!promotion) {
      return;
    }
    if (this.chaos.get().replication === 'drop-webhook' && type === 'replication.promotion.completed') {
      this.logger.warn({ failoverId: promotion.failoverId }, 'chaos: dropping the replication webhook');
      return;
    }
    if (!this.webhook) {
      this.logger.warn(
        { failoverId: promotion.failoverId },
        'no webhook configured; the sentry will time out',
      );
      return;
    }
    const event: ReplicationWebhookEvent = {
      eventId: `${promotion.promotionId}:${type.endsWith('completed') ? 'completed' : 'failed'}`,
      type,
      failoverId: promotion.failoverId,
      epoch: promotion.epoch,
      regionId: this.options.regionId,
      lsn: snapshot.lsn,
      dataLossTransactions,
      occurredAt: promotion.completedAt ?? new Date().toISOString(),
      error,
    };
    const delivery = this.webhook.send(event);
    this.pendingWebhooks.add(delivery);
    void delivery.finally(() => this.pendingWebhooks.delete(delivery));
  }
}
