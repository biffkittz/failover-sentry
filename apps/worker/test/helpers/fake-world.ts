/**
 * An in-memory "world" for workflow tests: regions with health and a simulated database, an edge, compute and an
 * alert channel. Its activities have the same signatures as the real ones, so the workflows run unmodified.
 */
import type {
  AlertRecord,
  DatabaseSnapshot,
  EdgeProbeResult,
  EdgeRouting,
  ProbeResult,
  ReplicationWebhookEvent,
} from '@failover-sentry/contracts';
import { ApplicationFailure } from '@temporalio/common';
import type { SentryActivities } from '../../src/activities/index.js';

export type PromotionBehaviour = 'complete' | 'stall' | 'fail' | 'drop-webhook';

export class FakeRegion {
  healthy = true;
  /** Whether the admin API answers; defaults to following `healthy`. */
  adminUp: boolean | null = null;
  computeStopped = false;
  latencyMs = 20;
  promotionBehaviour: PromotionBehaviour = 'complete';
  db: DatabaseSnapshot = {
    role: 'replica',
    epoch: 0,
    lsn: 100,
    appliedLsn: 100,
    lagSeconds: 0,
    promotion: null,
  };
  promotions = 0;

  constructor(readonly id: string) {}

  get reachable(): boolean {
    return !this.computeStopped && (this.adminUp ?? this.healthy);
  }
}

export class FakeWorld {
  readonly regions = new Map<string, FakeRegion>();
  edge: EdgeRouting | null = null;
  edgeFails = false;
  readonly alerts: AlertRecord[] = [];
  readonly webhooks: ReplicationWebhookEvent[] = [];
  promotionDelayMs = 300;
  webhookSink: ((event: ReplicationWebhookEvent) => Promise<void>) | null = null;
  private eventCounter = 0;

  constructor(regionIds: string[]) {
    for (const id of regionIds) {
      this.regions.set(id, new FakeRegion(id));
    }
  }

  region(id: string): FakeRegion {
    const region = this.regions.get(id);
    if (!region) {
      throw ApplicationFailure.nonRetryable(`unknown region ${id}`, 'NonRetryableHttpError');
    }
    return region;
  }

  private probeOf(region: FakeRegion): ProbeResult {
    const up = region.healthy && !region.computeStopped;
    return {
      regionId: region.id,
      at: new Date().toISOString(),
      ok: up,
      latencyMs: region.latencyMs,
      httpStatus: up ? 200 : 503,
      error: up ? null : 'HTTP 503',
      reportedStatus: up ? 'ok' : null,
      version: 'fake',
      db: up ? { ...region.db } : null,
      chaos: null,
    };
  }

  private finishPromotion(region: FakeRegion, failoverId: string, epoch: number): void {
    setTimeout(() => {
      if (region.db.promotion?.failoverId !== failoverId || region.db.promotion.epoch !== epoch) {
        return; // Superseded.
      }
      if (region.promotionBehaviour === 'stall') {
        return;
      }
      const failed = region.promotionBehaviour === 'fail';
      const promotion = region.db.promotion;
      if (!failed) {
        region.db = { ...region.db, role: 'primary', epoch, lagSeconds: null };
      }
      region.db.promotion = {
        ...promotion,
        status: failed ? 'failed' : 'completed',
        completedAt: new Date().toISOString(),
        error: failed ? 'simulated failure' : null,
      };
      if (region.promotionBehaviour === 'drop-webhook') {
        return;
      }
      this.eventCounter += 1;
      const event: ReplicationWebhookEvent = {
        eventId: `evt-${this.eventCounter}`,
        type: failed ? 'replication.promotion.failed' : 'replication.promotion.completed',
        failoverId,
        epoch,
        regionId: region.id,
        lsn: region.db.lsn,
        dataLossTransactions: 0,
        occurredAt: new Date().toISOString(),
        error: failed ? 'simulated failure' : null,
      };
      this.webhooks.push(event);
      void this.webhookSink?.(event);
    }, this.promotionDelayMs);
  }

  activities(): SentryActivities {
    return {
      probeRegion: async ({ regionId }) => this.probeOf(this.region(regionId)),

      probeEdge: async (): Promise<EdgeProbeResult> => {
        const routing = this.edge;
        const target = routing?.activeRegionId ? this.regions.get(routing.activeRegionId) : undefined;
        const ok =
          !this.edgeFails && routing?.mode === 'active' && Boolean(target?.healthy && !target.computeStopped);
        return {
          regionId: 'edge',
          at: new Date().toISOString(),
          ok,
          latencyMs: 30,
          httpStatus: ok ? 200 : 503,
          error: ok ? null : 'HTTP 503',
          reportedStatus: ok ? 'ok' : null,
          version: 'fake',
          db: target ? { ...target.db } : null,
          chaos: null,
          servedBy: routing?.activeRegionId ?? null,
          epoch: routing?.epoch ?? null,
        };
      },

      getDatabaseStatus: async ({ regionId }) => {
        const region = this.region(regionId);
        if (!region.reachable) {
          throw new Error(`${regionId} unreachable`);
        }
        return { ...region.db };
      },

      demoteDatabase: async ({ regionId, epoch }) => {
        const region = this.region(regionId);
        if (!region.reachable) {
          throw new Error(`${regionId} unreachable`);
        }
        if (epoch < region.db.epoch) {
          return { outcome: 'stale-epoch', currentEpoch: region.db.epoch };
        }
        region.db = { ...region.db, role: 'replica', epoch, lagSeconds: 0 };
        return { outcome: 'ok', db: { ...region.db }, promotionId: null };
      },

      requestDatabasePromotion: async ({ regionId, epoch, failoverId, mode }) => {
        const region = this.region(regionId);
        if (!region.reachable) {
          throw new Error(`${regionId} unreachable`);
        }
        const existing = region.db.promotion;
        if (existing && existing.failoverId === failoverId && existing.epoch === epoch) {
          return { outcome: 'ok', db: { ...region.db }, promotionId: existing.promotionId };
        }
        if (epoch <= region.db.epoch) {
          return { outcome: 'stale-epoch', currentEpoch: region.db.epoch };
        }
        region.promotions += 1;
        const promotionId = `${regionId}-p${region.promotions}`;
        const startedAt = new Date().toISOString();
        if (mode === 'restore') {
          region.db = {
            ...region.db,
            role: 'primary',
            epoch,
            lagSeconds: null,
            promotion: {
              promotionId,
              failoverId,
              epoch,
              mode,
              status: 'completed',
              startedAt,
              completedAt: startedAt,
              error: null,
            },
          };
          return { outcome: 'ok', db: { ...region.db }, promotionId };
        }
        region.db = {
          ...region.db,
          promotion: {
            promotionId,
            failoverId,
            epoch,
            mode,
            status: 'switching',
            startedAt,
            completedAt: null,
            error: null,
          },
        };
        this.finishPromotion(region, failoverId, epoch);
        return { outcome: 'ok', db: { ...region.db }, promotionId };
      },

      verifyDatabasePrimary: async ({ regionId, epoch }) => {
        const region = this.region(regionId);
        if (region.db.role !== 'primary' || region.db.epoch < epoch) {
          throw ApplicationFailure.retryable(`${regionId} not primary yet`, 'NotPrimaryYet');
        }
        return { ...region.db };
      },

      getEdgeRouting: async () => ({ routing: this.edge, colo: 'TEST' }),

      setEdgeRouting: async (input) => {
        const current = this.edge;
        if (
          current &&
          (input.epoch < current.epoch || (input.epoch === current.epoch && input.version < current.version))
        ) {
          return { outcome: 'stale', routing: current };
        }
        this.edge = { ...input, updatedAt: new Date().toISOString() };
        return { outcome: 'applied', routing: this.edge, colo: 'TEST' };
      },

      verifyEdgeRouting: async ({ expectedRegionId, minEpoch }) => {
        const routing = this.edge;
        if (!routing || routing.activeRegionId !== expectedRegionId || routing.epoch < minEpoch) {
          throw ApplicationFailure.nonRetryable('edge did not converge', 'EdgePropagationTimeout');
        }
        return { observedAt: new Date().toISOString(), colo: 'TEST', attempts: 1, routing };
      },

      stopRegionCompute: async ({ regionId }) => {
        const region = this.region(regionId);
        region.computeStopped = true;
        return { state: 'stopped', detail: `${regionId} stopped (fake)` };
      },

      startRegionCompute: async ({ regionId }) => {
        const region = this.region(regionId);
        region.computeStopped = false;
        region.healthy = true;
        region.adminUp = null;
        region.db = { role: 'replica', epoch: 0, lsn: 0, appliedLsn: 0, lagSeconds: 0, promotion: null };
        return { state: 'running', detail: `${regionId} started (fake)` };
      },

      tagRegionRoles: async ({ roles }) => ({ tagged: [], skipped: roles.map((role) => role.regionId) }),

      sendAlert: async ({ alert }) => {
        this.alerts.push(alert);
        return { delivery: 'sent', detail: 'captured by the fake world' };
      },
    };
  }
}
