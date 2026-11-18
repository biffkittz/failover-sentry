/**
 * One failover, as a sequence of durable steps with compensation (a saga).
 *
 *   PRECHECK → DRAIN_EDGE → FENCE_OLD_PRIMARY → PROMOTE_DATABASE → AWAIT_REPLICATION → VERIFY_PROMOTION
 *   → SWITCH_EDGE → AWAIT_EDGE_PROPAGATION → STABILIZATION → TAG_RESOURCES
 *
 * The order is what prevents split brain: traffic is drained and the old primary fenced *before* anything is
 * promoted, and traffic returns only after the new primary is verified. Every order carries the failover's epoch,
 * so a node or the edge refuses anything older.
 *
 * The steps run inside a cancellable scope owned by the sentry: an operator's abort cancels it, which interrupts the
 * current activity, timer or wait at once. Whatever the cause, `compensate` then runs in a non-cancellable scope
 * and moves everything back if the old primary can serve, or makes the safest choice left if it can't.
 */
import type {
  AlertKind,
  AlertSeverity,
  EdgeProbeResult,
  EdgeRouting,
  FailoverOutcome,
  FailoverRun,
  FailoverStepName,
  ProbeResult,
  RegionId,
  StallState,
  StepStatus,
} from '@failover-sentry/contracts';
import { ApplicationFailure, condition, isCancellation, patched, sleep } from '@temporalio/workflow';
import { compute, control, edgePropagation, quickCheck, verification } from '../activities.js';
import { describeFailure, failureType } from '../errors.js';
import { nowIso, type SentryState } from './state.js';

export interface FailoverHost {
  readonly state: SentryState;
  raiseAlert(
    kind: AlertKind,
    severity: AlertSeverity,
    title: string,
    message: string,
    options?: { failoverId?: string | null; regionId?: RegionId | null },
  ): void;
  /** Writes edge routing with the next write version; throws a non-retryable `StaleEpoch` failure when fenced. */
  writeEdge(
    update: { mode: EdgeRouting['mode']; activeRegionId: RegionId | null; failoverId: string | null },
    epoch: number,
  ): Promise<EdgeRouting>;
  probeRegion(regionId: RegionId): Promise<ProbeResult>;
  probeEdge(): Promise<EdgeProbeResult>;
}

/**
 * Patch: a planned failover needs a target that is replicating from the old primary (it catches up from it before
 * switching roles). Histories recorded before it replay as they ran.
 */
export const PATCH_PLANNED_NEEDS_REPLICATING_TARGET = 'planned-needs-replicating-target';

/**
 * A target that hasn't heard from the primary for longer than this can't catch up with it: a planned failover would
 * drain the edge and fence the primary, then fail. Regions poll their peers every second.
 */
const PLANNED_TARGET_CONTACT_LIMIT_SECONDS = 30;

interface StepResult {
  detail: string;
  status?: Extract<StepStatus, 'SUCCEEDED' | 'WARNING' | 'SKIPPED'>;
}

export class FailoverExecution {
  private abortedByOperator = false;

  constructor(
    private readonly host: FailoverHost,
    private readonly run: FailoverRun,
  ) {}

  private get policy() {
    return this.host.state.config.failover;
  }

  private get from(): RegionId {
    return this.run.fromRegionId;
  }

  private get to(): RegionId {
    return this.run.toRegionId;
  }

  /** Whether the forward path got as far as starting this step (what compensation has to undo). */
  private started(name: FailoverStepName): boolean {
    return this.run.steps.some((step) => step.name === name && step.status !== 'PENDING');
  }

  /** The forward path. Runs inside the sentry's cancellable failover scope. */
  async execute(): Promise<void> {
    await this.step('PRECHECK', () => this.precheck());
    await this.step('DRAIN_EDGE', () => this.drainEdge());
    await this.step('FENCE_OLD_PRIMARY', () => this.fenceOldPrimary());
    await this.step('PROMOTE_DATABASE', () => this.promoteTarget());
    await this.step('AWAIT_REPLICATION', () => this.awaitReplication());
    await this.step('VERIFY_PROMOTION', () => this.verifyPromotion());
    await this.step('SWITCH_EDGE', () => this.switchEdge());
    await this.step('AWAIT_EDGE_PROPAGATION', () => this.awaitEdgePropagation());
    await this.step('STABILIZATION', () => this.stabilize());
    await this.step('TAG_RESOURCES', () => this.tagResources(), { optional: true });
  }

  private async step(
    name: FailoverStepName,
    work: () => Promise<StepResult>,
    options: { optional?: boolean } = {},
  ) {
    const step = this.run.steps.find((candidate) => candidate.name === name);
    if (!step) {
      throw ApplicationFailure.nonRetryable(`Unknown failover step ${name}`);
    }
    this.run.phase = name;
    step.status = 'RUNNING';
    step.startedAt = nowIso();
    try {
      const result = await work();
      step.status = result.status ?? 'SUCCEEDED';
      step.detail = result.detail;
    } catch (error) {
      step.detail = describeFailure(error);
      if (isCancellation(error)) {
        step.status = 'CANCELLED';
        throw error;
      }
      if (options.optional) {
        step.status = 'WARNING';
        return;
      }
      step.status = 'FAILED';
      throw error;
    } finally {
      step.endedAt = nowIso();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Forward steps
  // ---------------------------------------------------------------------------------------------------------------

  private async precheck(): Promise<StepResult> {
    const target = await this.host.probeRegion(this.to);
    const operatorForced = this.run.trigger === 'MANUAL' && this.run.mode === 'forced';
    if (!target.ok && !operatorForced) {
      throw ApplicationFailure.nonRetryable(
        `Target ${this.to} failed its health check (${target.error ?? `HTTP ${target.httpStatus}`})`,
        'TargetUnhealthy',
      );
    }
    if (target.db?.role === 'primary') {
      throw ApplicationFailure.nonRetryable(
        `Target ${this.to} already claims to be primary (epoch ${target.db.epoch}); reconcile before failing over`,
        'TargetAlreadyPrimary',
      );
    }

    const notes: string[] = [];
    // A planned failover catches the target up from the old primary, so the target must be in contact with it.
    const notReplicating = patched(PATCH_PLANNED_NEEDS_REPLICATING_TARGET)
      ? this.notReplicating(target)
      : null;
    if (this.run.trigger === 'AUTOMATIC' && this.run.mode === 'forced') {
      // Like a "try planned before forced" policy: if the old primary's database still answers, sync first.
      try {
        const old = await quickCheck.getDatabaseStatus({ regionId: this.from });
        if (old.role === 'primary' && notReplicating) {
          notes.push(`old primary's database answers, but ${this.to} ${notReplicating}: forced failover`);
        } else if (old.role === 'primary') {
          this.run.mode = 'planned';
          notes.push(`old primary's database still answers: planned failover, no data loss`);
        }
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        notes.push(`old primary's database unreachable: forced failover`);
      }
    } else if (this.run.mode === 'planned') {
      let old;
      try {
        old = await quickCheck.getDatabaseStatus({ regionId: this.from });
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        throw ApplicationFailure.nonRetryable(
          `A planned failover needs the current primary's database, which is unreachable (${describeFailure(error)}); use a forced failover`,
          'PlannedNeedsPrimary',
        );
      }
      // Only with a primary to catch up from (a failover to the freshest region has none, and needs none).
      if (old.role === 'primary' && notReplicating) {
        throw ApplicationFailure.nonRetryable(
          `${this.to} ${notReplicating}, so it can't catch up with the primary for a planned failover; fix the connection between the regions, or use a forced failover`,
          'TargetNotReplicating',
        );
      }
    }
    const lag = target.db?.lagSeconds;
    return {
      detail: [
        `${this.host.state.displayName(this.to)} answers in ${target.latencyMs} ms${lag === null || lag === undefined ? '' : `, replication lag ${lag}s`}`,
        ...notes,
        `mode: ${this.run.mode}`,
      ].join('; '),
      status: target.ok ? 'SUCCEEDED' : 'WARNING',
    };
  }

  /**
   * Why the target isn't replicating from a primary (as reported by its own database, just now), or null when it
   * is, or when its region is too old to say.
   */
  private notReplicating(target: ProbeResult): string | null {
    const age = target.db?.primaryContactAgeSeconds;
    if (age === undefined) {
      return null;
    }
    if (age === null) {
      return 'has not heard from a primary since it started';
    }
    return age > PLANNED_TARGET_CONTACT_LIMIT_SECONDS ? `has not heard from the primary for ${age}s` : null;
  }

  private async drainEdge(): Promise<StepResult> {
    await this.host.writeEdge(
      { mode: 'maintenance', activeRegionId: this.from, failoverId: this.run.id },
      this.run.epoch,
    );
    return { detail: `Edge serves the holding page (epoch ${this.run.epoch}) while roles switch` };
  }

  private async fenceOldPrimary(): Promise<StepResult> {
    const notes: string[] = [];
    let warning = false;
    try {
      const result = await control.demoteDatabase({
        regionId: this.from,
        epoch: this.run.epoch,
        failoverId: this.run.id,
        reason: `failover ${this.run.id} to ${this.to}`,
      });
      if (result.outcome === 'stale-epoch') {
        throw ApplicationFailure.nonRetryable(
          `${this.from} holds epoch ${result.currentEpoch}, newer than this failover's ${this.run.epoch}`,
          'StaleEpoch',
        );
      }
      notes.push(`${this.from}'s database demoted to read-only at epoch ${this.run.epoch}`);
    } catch (error) {
      if (isCancellation(error) || this.run.mode === 'planned' || failureType(error) === 'StaleEpoch') {
        throw error;
      }
      warning = true;
      notes.push(
        `${this.from} unreachable (${describeFailure(error)}): fenced by epoch ${this.run.epoch} instead (the edge won't route to it and it demotes itself on contact)`,
      );
    }

    if (this.run.mode === 'forced' && this.policy.fenceComputeOnForcedFailover) {
      try {
        const result = await compute.stopRegionCompute({
          regionId: this.from,
          reason: `fenced by failover ${this.run.id}`,
        });
        this.host.state.regionCompute.set(this.from, 'stopped');
        notes.push(`compute stopped: ${result.detail}`);
        this.host.raiseAlert(
          'REGION_FENCED',
          'warning',
          `${this.host.state.displayName(this.from)} fenced`,
          `The sentry stopped ${this.from}'s compute during failover ${this.run.id}. Recover the region from the console once it is fixed.`,
          { failoverId: this.run.id, regionId: this.from },
        );
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        warning = true;
        notes.push(`could not stop compute: ${describeFailure(error)}`);
      }
    }
    return { detail: notes.join('; '), status: warning ? 'WARNING' : 'SUCCEEDED' };
  }

  private async promoteTarget(): Promise<StepResult> {
    const result = await control.requestDatabasePromotion({
      regionId: this.to,
      epoch: this.run.epoch,
      failoverId: this.run.id,
      mode: this.run.mode,
    });
    if (result.outcome === 'stale-epoch') {
      throw ApplicationFailure.nonRetryable(
        `${this.to} refused promotion: it holds epoch ${result.currentEpoch}`,
        'StaleEpoch',
      );
    }
    return {
      detail: `${this.to} accepted the ${this.run.mode} promotion (${result.promotionId ?? 'no id'}); waiting for its replication webhook`,
    };
  }

  /**
   * Waits for the replication-complete webhook (a signal) with a durable timeout. On timeout it first checks the
   * database directly, since webhooks get lost; only a real stall alerts a human, who can keep waiting, retry as a
   * forced promotion, or abort. After a decision the wait starts over; without one within the escalation window,
   * the failover reverts.
   */
  private async awaitReplication(): Promise<StepResult> {
    for (let round = 1; ; round += 1) {
      const confirmed = await condition(
        () => this.run.replication !== null,
        this.policy.replicationTimeoutSeconds * 1000,
      );
      if (confirmed) {
        return this.acceptConfirmation();
      }
      if (await this.confirmDirectly()) {
        this.host.raiseAlert(
          'REPLICATION_WEBHOOK_MISSING',
          'warning',
          'Replication webhook missing',
          `No replication webhook arrived within ${this.policy.replicationTimeoutSeconds}s for failover ${this.run.id}, but ${this.to}'s database reports primary at epoch ${this.run.epoch}. Proceeding; check the webhook path.`,
          { failoverId: this.run.id, regionId: this.to },
        );
        return {
          detail: `No webhook within ${this.policy.replicationTimeoutSeconds}s; promotion verified directly`,
          status: 'WARNING',
        };
      }

      const stall: StallState = { since: nowIso(), decision: null, decidedBy: null };
      this.run.stall = stall;
      this.run.phase = 'AWAITING_OPERATOR';
      this.host.raiseAlert(
        'REPLICATION_STALLED',
        'critical',
        round === 1 ? 'Replica sync stalled' : 'Replica sync still stalled',
        `${this.to}'s database hasn't confirmed promotion within ${this.policy.replicationTimeoutSeconds}s (failover ${this.run.id}). Keep waiting, retry as a forced promotion, or abort in the console; otherwise the sentry reverts in ${this.policy.stallEscalationSeconds}s.`,
        { failoverId: this.run.id, regionId: this.to },
      );

      const decided = await condition(
        () => this.run.replication !== null || stall.decision !== null,
        this.policy.stallEscalationSeconds * 1000,
      );
      this.run.phase = 'AWAIT_REPLICATION';
      if (this.run.replication) {
        return this.acceptConfirmation();
      }
      if (!decided) {
        if (await this.confirmDirectly()) {
          return { detail: 'Confirmed directly after the stall window', status: 'WARNING' };
        }
        throw ApplicationFailure.nonRetryable(
          `Replication stalled: no confirmation and no operator decision within ${this.policy.stallEscalationSeconds}s of the alert`,
          'ReplicationStalled',
        );
      }

      const decidedBy = stall.decidedBy ?? 'an operator';
      if (stall.decision === 'abort') {
        this.abortedByOperator = true;
        this.run.abortRequestedBy = decidedBy;
        throw ApplicationFailure.nonRetryable(
          `Aborted by ${decidedBy} while replication stalled`,
          'OperatorAbort',
        );
      }
      if (stall.decision === 'retry-forced') {
        // A new epoch supersedes the stuck promotion on the node.
        this.host.state.epoch += 1;
        this.run.epoch = this.host.state.epoch;
        this.run.mode = 'forced';
        const result = await control.requestDatabasePromotion({
          regionId: this.to,
          epoch: this.run.epoch,
          failoverId: this.run.id,
          mode: 'forced',
        });
        if (result.outcome === 'stale-epoch') {
          throw ApplicationFailure.nonRetryable(
            `${this.to} refused the forced retry (it holds epoch ${result.currentEpoch})`,
            'StaleEpoch',
          );
        }
        this.host.state.record(
          'STALL_RETRY_FORCED',
          `${decidedBy} retried as a forced promotion at epoch ${this.run.epoch}`,
          { severity: 'warning', failoverId: this.run.id },
        );
      } else {
        this.host.state.record('STALL_KEEP_WAITING', `${decidedBy} chose to keep waiting`, {
          failoverId: this.run.id,
        });
      }
      // Back to waiting for the webhook, with a fresh durable timeout.
      this.run.stall = null;
    }
  }

  private acceptConfirmation(): StepResult {
    const confirmation = this.run.replication;
    if (!confirmation) {
      throw ApplicationFailure.nonRetryable('No replication confirmation recorded');
    }
    this.run.stall = null;
    if (confirmation.status === 'failed') {
      throw ApplicationFailure.nonRetryable(
        `${this.to} reported that its promotion failed: ${confirmation.error ?? 'no reason given'}`,
        'PromotionFailed',
      );
    }
    const lost = confirmation.dataLossTransactions ?? 0;
    return {
      detail: `Confirmed by ${confirmation.source} at log position ${confirmation.lsn ?? '?'}${lost > 0 ? `; ${lost} transactions lost (forced)` : ''}`,
      status: lost > 0 ? 'WARNING' : 'SUCCEEDED',
    };
  }

  private async confirmDirectly(): Promise<boolean> {
    try {
      const db = await quickCheck.getDatabaseStatus({ regionId: this.to });
      if (db.role === 'primary' && db.epoch >= this.run.epoch) {
        this.run.replication = {
          source: 'direct-check',
          status: 'completed',
          receivedAt: nowIso(),
          eventId: null,
          lsn: db.lsn,
          dataLossTransactions: null,
          error: null,
        };
        return true;
      }
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
    }
    return false;
  }

  private async verifyPromotion(): Promise<StepResult> {
    const db = await verification.verifyDatabasePrimary({ regionId: this.to, epoch: this.run.epoch });
    return { detail: `${this.to}'s database is primary at epoch ${db.epoch}, log position ${db.lsn}` };
  }

  private async switchEdge(): Promise<StepResult> {
    const routing = await this.host.writeEdge(
      { mode: 'active', activeRegionId: this.to, failoverId: this.run.id },
      this.run.epoch,
    );
    return { detail: `Edge routes to ${this.to} (epoch ${routing.epoch}, version ${routing.version})` };
  }

  private async awaitEdgePropagation(): Promise<StepResult> {
    const edge = this.host.state.edge;
    const result = await edgePropagation(this.policy.edgePropagationTimeoutSeconds).verifyEdgeRouting({
      expectedRegionId: this.to,
      minEpoch: this.run.epoch,
      minVersion: edge?.version ?? 0,
      timeoutSeconds: this.policy.edgePropagationTimeoutSeconds,
    });
    return {
      detail: `Edge location ${result.colo} serves ${this.to} after ${result.attempts} check${result.attempts === 1 ? '' : 's'}`,
    };
  }

  /** Watches the new primary through the edge, the way users see it; repeated failures mean revert. */
  private async stabilize(): Promise<StepResult> {
    const seconds = this.policy.stabilizationSeconds;
    if (seconds <= 0) {
      return { detail: 'Stabilization watch disabled', status: 'SKIPPED' };
    }
    const endsAtMs = Date.now() + seconds * 1000;
    const progress = {
      probes: 0,
      consecutiveFailures: 0,
      lastProbe: null as EdgeProbeResult | null,
      endsAt: new Date(endsAtMs).toISOString(),
    };
    this.run.stabilization = progress;
    while (Date.now() < endsAtMs) {
      const probe = await this.host.probeEdge();
      progress.probes += 1;
      progress.lastProbe = probe;
      const anomaly = !probe.ok || (probe.servedBy !== null && probe.servedBy !== this.to);
      progress.consecutiveFailures = anomaly ? progress.consecutiveFailures + 1 : 0;
      if (progress.consecutiveFailures >= this.policy.stabilizationFailureThreshold) {
        throw ApplicationFailure.nonRetryable(
          `Anomaly while stabilizing: ${progress.consecutiveFailures} consecutive failed probes through the edge (last: ${probe.error ?? `HTTP ${probe.httpStatus}`}${probe.servedBy && probe.servedBy !== this.to ? `, served by ${probe.servedBy}` : ''})`,
          'StabilizationAnomaly',
        );
      }
      const remaining = endsAtMs - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(this.policy.stabilizationProbeIntervalSeconds * 1000, remaining));
    }
    return { detail: `${progress.probes} probes through the edge over ${seconds}s without anomalies` };
  }

  private async tagResources(): Promise<StepResult> {
    const result = await compute.tagRegionRoles({
      epoch: this.run.epoch,
      roles: this.host.state.config.regions.map((region) => ({
        regionId: region.id,
        role: region.id === this.to ? 'PRIMARY' : 'STANDBY',
      })),
    });
    if (result.tagged.length === 0) {
      return { detail: 'No taggable compute resources (simulated regions)', status: 'SKIPPED' };
    }
    return { detail: `Tagged dr-role/dr-epoch on ${result.tagged.join(', ')}` };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Compensation
  // ---------------------------------------------------------------------------------------------------------------

  /** Runs in a non-cancellable scope: cleanup must finish even when the failover was cancelled. */
  async compensate(error: unknown): Promise<FailoverOutcome> {
    const cancelled = isCancellation(error) || this.abortedByOperator;
    this.run.phase = 'COMPENSATING';
    if (!this.started('DRAIN_EDGE')) {
      this.compensation('Nothing to undo', 'SKIPPED', 'The failover stopped before changing anything');
      return cancelled ? 'ABORTED' : 'REVERTED';
    }

    const oldPrimary = await this.host.probeRegion(this.from);
    const oldPrimaryUsable = oldPrimary.ok && this.host.state.regionCompute.get(this.from) !== 'stopped';
    if (oldPrimaryUsable) {
      const ok = await this.revertToOldPrimary();
      if (ok) {
        return cancelled ? 'ABORTED' : 'REVERTED';
      }
      return 'MANUAL_INTERVENTION';
    }
    return this.keepTargetOrHold(oldPrimary);
  }

  private async revertToOldPrimary(): Promise<boolean> {
    const state = this.host.state;
    state.epoch += 1;
    const revertEpoch = state.epoch;
    let ok = true;

    if (this.started('SWITCH_EDGE')) {
      ok =
        (await this.attempt(`Drain the edge (it may route to ${this.to})`, () =>
          this.host.writeEdge(
            { mode: 'maintenance', activeRegionId: this.from, failoverId: this.run.id },
            revertEpoch,
          ),
        )) && ok;
    }
    if (this.started('PROMOTE_DATABASE')) {
      ok =
        (await this.attempt(`Demote ${this.to}`, async () => {
          const result = await control.demoteDatabase({
            regionId: this.to,
            epoch: revertEpoch,
            failoverId: this.run.id,
            reason: `revert of failover ${this.run.id}`,
          });
          if (result.outcome === 'stale-epoch') {
            throw new Error(`${this.to} holds a newer epoch (${result.currentEpoch})`);
          }
        })) && ok;
    }
    if (this.started('FENCE_OLD_PRIMARY')) {
      ok =
        (await this.attempt(`Restore ${this.from} as primary`, async () => {
          const result = await control.requestDatabasePromotion({
            regionId: this.from,
            epoch: revertEpoch,
            failoverId: `${this.run.id}-revert`,
            mode: 'restore',
          });
          if (result.outcome === 'stale-epoch') {
            throw new Error(`${this.from} holds a newer epoch (${result.currentEpoch})`);
          }
          await verification.verifyDatabasePrimary({ regionId: this.from, epoch: revertEpoch });
        })) && ok;
    }
    ok =
      (await this.attempt(`Route the edge back to ${this.from}`, () =>
        this.host.writeEdge(
          { mode: 'active', activeRegionId: this.from, failoverId: this.run.id },
          revertEpoch,
        ),
      )) && ok;
    return ok;
  }

  /** The old primary can't serve, so reverting would make things worse: keep the target if it is primary. */
  private async keepTargetOrHold(oldPrimary: ProbeResult): Promise<FailoverOutcome> {
    const state = this.host.state;
    const why = oldPrimary.ok
      ? 'its compute is stopped'
      : (oldPrimary.error ?? `HTTP ${oldPrimary.httpStatus}`);
    this.compensation(`Revert to ${this.from}`, 'SKIPPED', `Not possible: ${this.from} can't serve (${why})`);
    if (this.started('PROMOTE_DATABASE')) {
      const targetIsPrimary = await quickCheck.getDatabaseStatus({ regionId: this.to }).then(
        (db) => db.role === 'primary' && db.epoch >= this.run.epoch,
        () => false,
      );
      if (targetIsPrimary) {
        const routed = await this.attempt(`Keep traffic on ${this.to}`, () =>
          this.host.writeEdge(
            { mode: 'active', activeRegionId: this.to, failoverId: this.run.id },
            this.run.epoch,
          ),
        );
        if (routed) {
          state.activeRegionId = this.to;
          return 'KEPT_TARGET';
        }
      }
    }
    await this.attempt('Hold traffic on the maintenance page', () =>
      this.host.writeEdge(
        { mode: 'maintenance', activeRegionId: this.from, failoverId: this.run.id },
        state.epoch,
      ),
    );
    return 'MANUAL_INTERVENTION';
  }

  private async attempt(action: string, work: () => Promise<unknown>): Promise<boolean> {
    try {
      await work();
      this.compensation(action, 'SUCCEEDED', null);
      return true;
    } catch (error) {
      this.compensation(action, 'FAILED', describeFailure(error));
      return false;
    }
  }

  private compensation(
    action: string,
    status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED',
    detail: string | null,
  ): void {
    this.run.compensations.push({ action, status, at: nowIso(), detail });
  }
}
