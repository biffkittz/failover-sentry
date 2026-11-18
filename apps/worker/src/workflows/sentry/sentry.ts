/**
 * The Failover Sentry: a durable, singleton orchestrator per protected service.
 *
 * It alternates between two branches:
 *
 * 1. Normal operations, inside a cancellable scope: one monitor child workflow per region (supervised and restarted
 *    if one ends), plus a reconciler that keeps reality in line with intent (exactly one primary database, the edge
 *    routing to it, stale primaries fenced). Health reports arrive as signals; the sentry decides.
 * 2. A failover, inside its own cancellable scope, followed by compensation in a non-cancellable one.
 *
 * Leaving normal operations (an automatic decision, the emergency failover Update, a reconfiguration, or
 * continue-as-new) cancels its scope: the monitors stop and every timer and pending activity in the branch is
 * cancelled with them, so nothing keeps running in the background while the failover branch takes over.
 */
import {
  monitorWorkflowId,
  type AbortFailoverRequest,
  type AbortFailoverResult,
  type AcknowledgeAlertRequest,
  type AlertKind,
  type AlertRecord,
  type AlertSeverity,
  type EdgeProbeResult,
  type EdgeRouting,
  type FailoverAccepted,
  type FailoverRun,
  type ManualFailoverRequest,
  type ProbeResult,
  type ReconfigureRequest,
  type ReconfigureResult,
  type RecoverRegionAccepted,
  type RecoverRegionRequest,
  type RegionConfig,
  type RegionHealthReport,
  type RegionId,
  type RegionRecovery,
  type ReplicationCompleteSignalPayload,
  type ResolveStallRequest,
  type ResolveStallResult,
  type SentryWorkflowInput,
  type SetAutoFailoverRequest,
  type SetAutoFailoverResult,
} from '@failover-sentry/contracts';
import {
  abortFailoverUpdate,
  acknowledgeAlertUpdate,
  getSentryStateQuery,
  reconfigureUpdate,
  recoverRegionUpdate,
  regionHealthReportSignal,
  replicationCompleteSignal,
  resolveStallUpdate,
  setAutoFailoverUpdate,
  triggerFailoverUpdate,
} from '@failover-sentry/contracts/temporal';
import {
  allHandlersFinished,
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowCancellationType,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  isCancellation,
  ParentClosePolicy,
  patched,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
  WorkflowIdReusePolicy,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { decideAutomaticFailover, planReconciliation, type ReconcileAction } from '../../domain/decisions.js';
import { alerts, control, probeActivities, verification } from '../activities.js';
import { describeFailure } from '../errors.js';
import { monitorRegionChild } from '../monitor-region.js';
import { FailoverExecution, type FailoverHost } from './failover.js';
import { recoverRegion } from './recovery.js';
import { nowIso, SentryState, type FailoverTrigger } from './state.js';
import {
  requireActor,
  resolveManualTarget,
  validateAbortFailover,
  validateAcknowledgeAlert,
  validateRecoverRegion,
  validateReconfigure,
  validateResolveStall,
  validateTriggerFailover,
} from './validators.js';

type NormalOperationsExit =
  { kind: 'failover'; trigger: FailoverTrigger } | { kind: 'reconfigure' } | { kind: 'continue-as-new' };

/** History length at which the sentry continues as new even if the server hasn't suggested it yet. */
const MAX_HISTORY_EVENTS = 20_000;

/**
 * Patch: after a failover, decide only on health reports observed after it ended (see SentryState.healthValidSince).
 * Histories recorded before it replay as they ran.
 */
export const PATCH_FRESH_HEALTH_AFTER_FAILOVER = 'fresh-health-after-failover';

/** Patch: stop the monitors by workflow ID, reaching their current run (see stopMonitors). */
export const PATCH_CANCEL_MONITORS_BY_ID = 'cancel-monitors-by-workflow-id';

export class Sentry implements FailoverHost {
  readonly state: SentryState;
  private pendingTrigger: FailoverTrigger | null = null;
  private pendingReconfigure: ReconfigureRequest | null = null;
  private failoverScope: CancellationScope | null = null;
  private readonly backgroundTasks = new Set<Promise<void>>();
  /** Regions whose monitor child has started (and not ended): the ones stopMonitors has to reach. */
  private readonly startedMonitors = new Set<RegionId>();
  private lastFinishedFailoverId: string | null = null;
  private noTargetAlerted = false;
  private cooldownNoted = false;
  private freshestNoted = false;

  constructor(input: SentryWorkflowInput) {
    this.state = new SentryState(input);
  }

  async run(): Promise<never> {
    this.registerHandlers();
    if (this.state.resumed) {
      this.state.record('CONTINUED_AS_NEW', `Run ${this.state.continuedAsNewCount} of the sentry started`);
    } else {
      await this.discover();
    }
    for (;;) {
      const exit = await this.runNormalOperations();
      switch (exit.kind) {
        case 'failover':
          await this.runFailover(exit.trigger);
          break;
        case 'reconfigure':
          this.applyReconfigure();
          break;
        case 'continue-as-new':
          if (await this.readyToContinueAsNew()) {
            return this.continueAsNewNow();
          }
          // An Update is waiting for the main loop (a failover or a reconfiguration): serve it first; normal
          // operations will choose to continue as new again afterwards.
          break;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------------------------------------------

  /** On a first start, adopt whatever the edge already routes to: the edge is where traffic really goes. */
  private async discover(): Promise<void> {
    const { config } = this.state;
    this.state.record(
      'SENTRY_STARTED',
      `Sentry for ${config.serviceName} started: ${config.regions.map((region) => region.id).join(', ')}; initial primary ${config.initialPrimaryRegionId}`,
    );
    try {
      const { routing, colo } = await control.getEdgeRouting();
      if (!routing) {
        this.state.record(
          'EDGE_EMPTY',
          'The edge has no routing yet; it will be set once a primary is established',
        );
        return;
      }
      this.state.edge = routing;
      this.state.epoch = Math.max(this.state.epoch, routing.epoch);
      this.state.sequence = Math.max(this.state.sequence, routing.version);
      if (routing.activeRegionId && this.state.region(routing.activeRegionId)) {
        this.state.activeRegionId = routing.activeRegionId;
      }
      this.state.record(
        'EDGE_ADOPTED',
        `The edge (${colo}) routes ${routing.mode} to ${routing.activeRegionId ?? 'nothing'} at epoch ${routing.epoch}: adopted`,
      );
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      this.state.record('EDGE_UNREACHABLE', `Could not read the edge routing: ${describeFailure(error)}`, {
        severity: 'warning',
      });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Normal operations
  // -------------------------------------------------------------------------------------------------------------

  private async runNormalOperations(): Promise<NormalOperationsExit> {
    const scope = new CancellationScope();
    const background = scope.run(() => settleAll([this.superviseMonitors(), this.reconcileLoop()]));

    await condition(() => this.exitReason() !== null);
    const exit = this.exitReason();
    if (!exit) {
      throw ApplicationFailure.nonRetryable('Normal operations ended without a reason');
    }
    // A failover trigger stays pending until runFailover has taken over: while the monitors are still stopping,
    // it is what makes the validators and the automatic decision refuse a second failover.

    // Stop the monitors, the reconciler and every timer they own before taking another branch.
    if (patched(PATCH_CANCEL_MONITORS_BY_ID)) {
      await this.stopMonitors();
    }
    scope.cancel();
    try {
      await background;
    } catch (error) {
      if (!isCancellation(error)) {
        throw error;
      }
    }
    return exit;
  }

  private exitReason(): NormalOperationsExit | null {
    if (this.pendingTrigger) {
      return { kind: 'failover', trigger: this.pendingTrigger };
    }
    if (this.pendingReconfigure) {
      return { kind: 'reconfigure' };
    }
    const info = workflowInfo();
    const historyIsLong = info.continueAsNewSuggested || info.historyLength > MAX_HISTORY_EVENTS;
    if (historyIsLong && !this.recoveryInProgress()) {
      return { kind: 'continue-as-new' };
    }
    return null;
  }

  /** One monitor child per region, restarted with backoff if it ever ends while normal operations run. */
  private async superviseMonitors(): Promise<void> {
    await settleAll(this.state.config.regions.map((region) => this.superviseMonitor(region)));
  }

  private async superviseMonitor(region: RegionConfig): Promise<void> {
    const sentryWorkflowId = workflowInfo().workflowId;
    const workflowId = monitorWorkflowId(sentryWorkflowId, region.id);
    for (let restarts = 0; ; restarts += 1) {
      try {
        const handle = await startChild(monitorRegionChild, {
          workflowId,
          args: [
            {
              sentryWorkflowId,
              region,
              role: region.id === this.state.activeRegionId ? 'PRIMARY' : 'STANDBY',
              policy: this.state.config.health,
            },
          ],
          // Cancelling the normal-operations scope cancels the child and waits until it has really stopped, so
          // the next normal-operations cycle can reuse the workflow ID.
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          // If the sentry itself is terminated, its monitors are asked to stop rather than left orphaned.
          parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        });
        this.startedMonitors.add(region.id);
        try {
          await handle.result();
        } finally {
          this.startedMonitors.delete(region.id);
        }
        this.state.record('MONITOR_ENDED', `The monitor of ${region.id} ended; restarting it`, {
          severity: 'warning',
          regionId: region.id,
        });
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          // A monitor from an earlier sentry run is still alive (after a reset, say): ask it to stop first.
          try {
            await getExternalWorkflowHandle(workflowId).cancel();
          } catch (cancelError) {
            if (isCancellation(cancelError)) {
              throw cancelError;
            }
          }
        }
        this.state.record('MONITOR_FAILED', `The monitor of ${region.id} failed: ${describeFailure(error)}`, {
          severity: 'warning',
          regionId: region.id,
        });
      }
      await sleep(Math.min(60_000, 2_000 * 2 ** Math.min(restarts, 5)));
    }
  }

  /**
   * Asks each monitor's current run to stop. Cancelling a child (as the scope's cancellation does) targets the run
   * the parent started, and a monitor that has since continued as new never receives it: the scope would then
   * wait for it forever. Cancelling by workflow ID alone reaches the current run of the chain; the scope's own
   * cancellation then completes when that run has stopped.
   *
   * Only monitors that have started: one still starting is on its first run, which the scope's cancellation
   * reaches (and Temporal refuses to start and cancel a child in the same workflow task).
   */
  private async stopMonitors(): Promise<void> {
    const sentryWorkflowId = workflowInfo().workflowId;
    await Promise.all(
      [...this.startedMonitors].map(async (regionId) => {
        try {
          await getExternalWorkflowHandle(monitorWorkflowId(sentryWorkflowId, regionId)).cancel();
        } catch {
          // Ended meanwhile: nothing to stop.
        }
      }),
    );
  }

  /** Keeps reality in line with the sentry's intent, one corrective action at a time. */
  private async reconcileLoop(): Promise<void> {
    let failures = 0;
    for (;;) {
      await condition(() => this.reconciliationPlan() !== null);
      const action = this.reconciliationPlan();
      if (!action) {
        continue;
      }
      try {
        await this.reconcile(action);
        failures = 0;
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        failures += 1;
        this.state.record(
          'RECONCILE_FAILED',
          `${action.kind} for ${action.regionId} failed: ${describeFailure(error)}`,
          {
            severity: 'warning',
            regionId: action.regionId,
          },
        );
      }
      // Give the monitors time to observe the effect before planning again; back off after failures.
      const settleMs = this.state.config.health.probeIntervalSeconds * 2_000;
      await sleep(Math.min(5 * 60_000, settleMs * 2 ** Math.min(failures, 4)));
    }
  }

  private reconciliationPlan(): ReconcileAction | null {
    if (this.state.mode === 'FAILING_OVER' || this.pendingTrigger || this.state.currentFailover) {
      return null;
    }
    const plan = planReconciliation({
      ...this.state.decisionContext(),
      epoch: this.state.epoch,
      edge: this.state.edge,
    });
    if (plan?.kind === 'failover-to-freshest' && !this.state.autoFailoverEnabled && this.freshestNoted) {
      return null; // Already reported; an operator has to move traffic.
    }
    return plan;
  }

  private async reconcile(action: ReconcileAction): Promise<void> {
    const name = this.state.displayName(action.regionId);
    switch (action.kind) {
      case 'fence-stale-primary': {
        const result = await control.demoteDatabase({
          regionId: action.regionId,
          epoch: this.state.epoch,
          failoverId: null,
          reason: 'split-brain fencing by the sentry',
        });
        if (result.outcome === 'stale-epoch') {
          this.state.epoch = Math.max(this.state.epoch, result.currentEpoch);
          throw ApplicationFailure.nonRetryable(
            `${name} holds epoch ${result.currentEpoch}; adopted it for the next attempt`,
          );
        }
        this.raiseAlert(
          'SPLIT_BRAIN_FENCED',
          'critical',
          `Split brain fenced: ${name}`,
          `${name} still claimed to be primary (epoch ${action.reportedEpoch}) while ${this.state.displayName(this.state.activeRegionId)} is primary at epoch ${this.state.epoch}. The sentry demoted it; the edge never routed to it.`,
          { regionId: action.regionId },
        );
        return;
      }
      case 'restore-active-primary': {
        this.state.epoch = Math.max(this.state.epoch, action.epochFloor) + 1;
        const epoch = this.state.epoch;
        const result = await control.requestDatabasePromotion({
          regionId: action.regionId,
          epoch,
          failoverId: this.state.nextId('restore'),
          mode: 'restore',
        });
        if (result.outcome === 'stale-epoch') {
          this.state.epoch = Math.max(this.state.epoch, result.currentEpoch);
          throw ApplicationFailure.nonRetryable(
            `${name} holds epoch ${result.currentEpoch}; adopted it for the next attempt`,
          );
        }
        await verification.verifyDatabasePrimary({ regionId: action.regionId, epoch });
        this.state.record(
          'PRIMARY_ESTABLISHED',
          `${name}'s database is primary at epoch ${epoch} (none was)`,
          {
            severity: 'warning',
            regionId: action.regionId,
          },
        );
        return;
      }
      case 'failover-to-freshest': {
        if (!this.state.autoFailoverEnabled) {
          this.freshestNoted = true;
          this.state.record(
            'DATA_ON_STANDBY',
            `${action.reason}; automatic failover is off, so an operator must fail over`,
            {
              severity: 'warning',
              regionId: action.regionId,
            },
          );
          return;
        }
        this.pendingTrigger = {
          failoverId: this.state.nextId('fo'),
          kind: 'AUTOMATIC',
          targetRegionId: action.regionId,
          mode: 'planned',
          reason: action.reason,
          requestedBy: null,
        };
        return;
      }
      case 'sync-edge': {
        const routing = await this.writeEdge(
          { mode: 'active', activeRegionId: action.regionId, failoverId: null },
          this.state.epoch,
        );
        this.state.record(
          'EDGE_SYNCED',
          `The edge routes to ${name} (epoch ${routing.epoch}, version ${routing.version})`,
          {
            regionId: action.regionId,
          },
        );
        return;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Failover branch
  // -------------------------------------------------------------------------------------------------------------

  private async runFailover(trigger: FailoverTrigger): Promise<void> {
    const state = this.state;
    const from = state.activeRegionId;
    state.epoch += 1;
    const run = state.newFailoverRun(trigger, from, state.epoch);
    state.currentFailover = run;
    state.mode = 'FAILING_OVER';
    this.pendingTrigger = null; // currentFailover guards from here on.
    if (trigger.kind === 'AUTOMATIC') {
      state.lastAutomaticFailoverAt = nowIso();
    }
    const automatic = trigger.kind === 'AUTOMATIC';
    this.raiseAlert(
      'FAILOVER_STARTED',
      automatic ? 'critical' : 'warning',
      `${automatic ? 'Automatic' : 'Manual'} ${run.mode} failover: ${state.displayName(from)} → ${state.displayName(run.toRegionId)}`,
      `${trigger.reason}${trigger.requestedBy ? ` (requested by ${trigger.requestedBy})` : ''}. Epoch ${run.epoch}.`,
      { failoverId: run.id },
    );

    const execution = new FailoverExecution(this, run);
    const scope = new CancellationScope();
    this.failoverScope = scope;
    try {
      await scope.run(() => execution.execute());
      run.outcome = 'SUCCEEDED';
      state.activeRegionId = run.toRegionId;
      this.raiseAlert(
        'FAILOVER_COMPLETED',
        automatic ? 'warning' : 'info',
        `Failover complete: ${state.displayName(run.toRegionId)} is primary`,
        `Traffic and the primary database moved from ${from} to ${run.toRegionId} at epoch ${run.epoch}.`,
        { failoverId: run.id },
      );
    } catch (error) {
      run.error = describeFailure(error);
      // Cleanup must finish even though the failover scope may have been cancelled.
      run.outcome = await CancellationScope.nonCancellable(() => execution.compensate(error));
      this.reportOutcome(run);
    } finally {
      this.failoverScope = null;
      run.phase = 'DONE';
      run.endedAt = nowIso();
      state.currentFailover = null;
      state.archive(run);
      this.lastFinishedFailoverId = run.id;
      if (patched(PATCH_FRESH_HEALTH_AFTER_FAILOVER)) {
        // Health observed before now describes the old roles (the old primary still "primary"); deciding on it
        // would, for one, fence the old primary as a split brain right after every planned failover. The
        // restarted monitors report within one probe interval.
        state.healthValidSince = run.endedAt;
      }
      if (state.mode === 'FAILING_OVER') {
        state.mode = 'NORMAL';
      }
      this.noTargetAlerted = false;
      this.cooldownNoted = false;
    }
  }

  private reportOutcome(run: FailoverRun): void {
    const state = this.state;
    const options = { failoverId: run.id };
    switch (run.outcome) {
      case 'ABORTED':
        this.raiseAlert(
          'FAILOVER_ABORTED',
          'warning',
          `Failover ${run.id} aborted`,
          `Aborted${run.abortRequestedBy ? ` by ${run.abortRequestedBy}` : ''} during ${run.steps.find((step) => step.status === 'CANCELLED' || step.status === 'FAILED')?.name ?? 'the failover'}; ${run.fromRegionId} remains primary.`,
          options,
        );
        break;
      case 'REVERTED':
        this.raiseAlert(
          'FAILOVER_REVERTED',
          'critical',
          `Failover ${run.id} reverted`,
          `${run.error ?? 'The failover failed'}. Traffic and the primary database are back on ${run.fromRegionId}.`,
          options,
        );
        break;
      case 'KEPT_TARGET':
        this.raiseAlert(
          'MANUAL_INTERVENTION_REQUIRED',
          'warning',
          `Failover ${run.id} kept ${run.toRegionId}`,
          `${run.error ?? 'The failover failed'}, and ${run.fromRegionId} can't serve, so the sentry kept traffic on ${run.toRegionId}. Review it.`,
          options,
        );
        break;
      case 'MANUAL_INTERVENTION':
      default:
        state.mode = 'MANUAL_INTERVENTION_REQUIRED';
        state.autoFailoverEnabled = false;
        state.autoFailoverSuspendedReason = `Failover ${run.id} needs manual intervention`;
        this.raiseAlert(
          'MANUAL_INTERVENTION_REQUIRED',
          'critical',
          'Manual intervention required',
          `${run.error ?? 'The failover failed'}, and the sentry could not restore service automatically. The edge shows the maintenance page; automatic failover is suspended.`,
          options,
        );
        break;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // FailoverHost
  // -------------------------------------------------------------------------------------------------------------

  raiseAlert(
    kind: AlertKind,
    severity: AlertSeverity,
    title: string,
    message: string,
    options: { failoverId?: string | null; regionId?: RegionId | null } = {},
  ): void {
    const alert = this.state.addAlert(kind, severity, title, message, options);
    // Delivered in the background and outside any cancellable scope: aborting a failover must not swallow alerts.
    this.spawn(() => this.deliver(alert));
  }

  private async deliver(alert: AlertRecord): Promise<void> {
    try {
      const result = await CancellationScope.nonCancellable(() =>
        alerts.sendAlert({
          alert,
          serviceName: this.state.config.serviceName,
          consoleUrl: this.state.config.consoleUrl,
        }),
      );
      alert.delivery = result.delivery;
      alert.deliveryDetail = result.detail;
    } catch (error) {
      alert.delivery = 'failed';
      alert.deliveryDetail = describeFailure(error);
    }
  }

  async writeEdge(
    update: { mode: EdgeRouting['mode']; activeRegionId: RegionId | null; failoverId: string | null },
    epoch: number,
  ): Promise<EdgeRouting> {
    const version = this.state.nextVersion();
    const result = await control.setEdgeRouting({ ...update, epoch, version });
    if (result.outcome === 'stale') {
      const holder = result.routing;
      if (holder) {
        this.state.epoch = Math.max(this.state.epoch, holder.epoch);
        this.state.sequence = Math.max(this.state.sequence, holder.version);
        this.state.edge = holder;
      }
      throw ApplicationFailure.nonRetryable(
        `The edge refused the write (epoch ${epoch}, version ${version}): it holds epoch ${holder?.epoch ?? '?'}, version ${holder?.version ?? '?'}`,
        'StaleEpoch',
      );
    }
    this.state.edge = result.routing;
    return result.routing;
  }

  probeRegion(regionId: RegionId): Promise<ProbeResult> {
    const timeoutMs = this.state.config.health.probeTimeoutMs;
    return probeActivities(timeoutMs).probeRegion({ regionId, timeoutMs });
  }

  probeEdge(): Promise<EdgeProbeResult> {
    const timeoutMs = this.state.config.health.probeTimeoutMs;
    return probeActivities(timeoutMs).probeEdge({ timeoutMs });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------------------------------------------

  private registerHandlers(): void {
    setHandler(getSentryStateQuery, () => this.state.view(this.cooldownUntil()));
    setHandler(regionHealthReportSignal, (report) => this.onHealthReport(report));
    setHandler(replicationCompleteSignal, (payload) => this.onReplicationComplete(payload));
    const state = this.state;
    setHandler(triggerFailoverUpdate, (request) => this.onTriggerFailover(request), {
      validator: (request) => validateTriggerFailover(state, request, this.pendingTrigger !== null),
    });
    setHandler(abortFailoverUpdate, (request) => this.onAbortFailover(request), {
      validator: (request) => validateAbortFailover(state, request, this.failoverScope !== null),
    });
    setHandler(setAutoFailoverUpdate, (request) => this.onSetAutoFailover(request), {
      validator: (request) => requireActor(request.requestedBy),
    });
    setHandler(resolveStallUpdate, (request) => this.onResolveStall(request), {
      validator: (request) => validateResolveStall(state, request),
    });
    setHandler(acknowledgeAlertUpdate, (request) => this.onAcknowledgeAlert(request), {
      validator: (request) => validateAcknowledgeAlert(state, request),
    });
    setHandler(recoverRegionUpdate, (request) => this.onRecoverRegion(request), {
      validator: (request) => validateRecoverRegion(state, request),
    });
    setHandler(reconfigureUpdate, (request) => this.onReconfigure(request), {
      validator: (request) => validateReconfigure(state, request),
    });
  }

  private onHealthReport(report: RegionHealthReport): void {
    const { snapshot } = report;
    if (!this.state.region(snapshot.regionId)) {
      return;
    }
    const previous = this.state.regionHealth.get(snapshot.regionId);
    if (
      previous &&
      previous.monitorInstanceId === snapshot.monitorInstanceId &&
      previous.sequence >= snapshot.sequence
    ) {
      return; // Out of order or duplicated.
    }
    this.state.regionHealth.set(snapshot.regionId, snapshot);
    if (snapshot.lastProbe?.ok && this.state.regionCompute.get(snapshot.regionId) === 'unknown') {
      this.state.regionCompute.set(snapshot.regionId, 'running'); // It answers, so its compute runs.
    }
    const name = this.state.displayName(snapshot.regionId);
    if (
      report.reason === 'STATUS_CHANGED' ||
      (report.reason === 'FIRST_PROBE' && snapshot.status !== 'HEALTHY')
    ) {
      const probe = snapshot.lastProbe;
      const detail = probe?.ok ? `${probe.latencyMs} ms` : (probe?.error ?? 'no answer');
      this.state.record('REGION_HEALTH', `${name} is ${snapshot.status} (${detail})`, {
        severity: snapshot.status === 'UNHEALTHY' ? 'warning' : 'info',
        regionId: snapshot.regionId,
      });
    } else if (report.reason === 'DATABASE_CHANGED' && snapshot.lastProbe?.db) {
      const db = snapshot.lastProbe.db;
      this.state.record('REGION_DATABASE', `${name}'s database is ${db.role} at epoch ${db.epoch}`, {
        regionId: snapshot.regionId,
      });
    }
    this.evaluateAutomaticFailover();
  }

  private evaluateAutomaticFailover(): void {
    if (
      this.state.mode !== 'NORMAL' ||
      this.pendingTrigger ||
      this.state.currentFailover ||
      !this.state.autoFailoverEnabled
    ) {
      return;
    }
    const lastAutomatic = this.state.lastAutomaticFailoverAt;
    const decision = decideAutomaticFailover({
      ...this.state.decisionContext(),
      lastAutomaticFailoverAtMs: lastAutomatic ? Date.parse(lastAutomatic) : null,
    });
    switch (decision.kind) {
      case 'none':
        this.noTargetAlerted = false;
        this.cooldownNoted = false;
        return;
      case 'cooldown':
        if (!this.cooldownNoted) {
          this.cooldownNoted = true;
          this.state.record('AUTO_FAILOVER_COOLDOWN', `The primary is UNHEALTHY, but ${decision.reason}`, {
            severity: 'warning',
          });
        }
        return;
      case 'no-target':
        if (!this.noTargetAlerted) {
          this.noTargetAlerted = true;
          this.raiseAlert(
            'NO_FAILOVER_TARGET',
            'critical',
            'Primary unhealthy, no healthy standby',
            decision.reason,
            {
              regionId: this.state.activeRegionId,
            },
          );
        }
        return;
      case 'failover':
        this.pendingTrigger = {
          failoverId: this.state.nextId('fo'),
          kind: 'AUTOMATIC',
          targetRegionId: decision.targetRegionId,
          mode: decision.mode,
          reason: decision.reason,
          requestedBy: null,
        };
        return;
    }
  }

  private onReplicationComplete(payload: ReplicationCompleteSignalPayload): void {
    if (!this.state.rememberEvent(payload.eventId)) {
      return; // A redelivery: the webhook gateway delivers at least once.
    }
    const run = this.state.currentFailover;
    const label = `Webhook ${payload.type} from ${payload.regionId} (failover ${payload.failoverId}, epoch ${payload.epoch})`;
    if (!run || run.id !== payload.failoverId) {
      this.state.record('WEBHOOK_IGNORED', `${label}: no such failover in progress`, {
        regionId: payload.regionId,
      });
      return;
    }
    if (payload.regionId !== run.toRegionId || payload.epoch < run.epoch) {
      this.state.record('WEBHOOK_IGNORED', `${label}: stale or for another region`, {
        severity: 'warning',
        failoverId: run.id,
        regionId: payload.regionId,
      });
      return;
    }
    if (run.replication) {
      return; // The first confirmation wins.
    }
    run.replication = {
      source: 'webhook',
      status: payload.type === 'replication.promotion.completed' ? 'completed' : 'failed',
      receivedAt: payload.receivedAt,
      eventId: payload.eventId,
      lsn: payload.lsn,
      dataLossTransactions: payload.dataLossTransactions,
      error: payload.error,
    };
    this.state.record('REPLICATION_WEBHOOK', `${label} received`, {
      severity: run.replication.status === 'failed' ? 'warning' : 'info',
      failoverId: run.id,
      regionId: payload.regionId,
    });
  }

  private async onTriggerFailover(request: ManualFailoverRequest): Promise<FailoverAccepted> {
    const targetRegionId = resolveManualTarget(this.state, request);
    const failoverId = this.state.nextId('fo');
    const reason = request.reason.trim();
    this.pendingTrigger = {
      failoverId,
      kind: 'MANUAL',
      targetRegionId,
      mode: request.mode,
      reason,
      requestedBy: request.requestedBy,
    };
    this.state.record(
      'FAILOVER_REQUESTED',
      `${request.requestedBy} requested a ${request.mode} failover to ${targetRegionId}: ${reason}`,
      { severity: 'warning', failoverId },
    );
    // Acknowledge once the failover branch has taken over (normal operations stopped), not when it ends.
    await condition(
      () => this.state.currentFailover?.id === failoverId || this.lastFinishedFailoverId === failoverId,
    );
    const run =
      this.state.currentFailover?.id === failoverId
        ? this.state.currentFailover
        : this.state.recentFailovers.find((candidate) => candidate.id === failoverId);
    return {
      failoverId,
      epoch: run?.epoch ?? this.state.epoch,
      fromRegionId: run?.fromRegionId ?? this.state.activeRegionId,
      toRegionId: targetRegionId,
      mode: run?.mode ?? request.mode,
    };
  }

  private onAbortFailover(request: AbortFailoverRequest): AbortFailoverResult {
    const run = this.state.currentFailover;
    const scope = this.failoverScope;
    if (!run || !scope) {
      throw ApplicationFailure.nonRetryable('No failover is in progress');
    }
    const phase = run.phase;
    run.abortRequestedBy = request.requestedBy;
    this.state.record(
      'FAILOVER_ABORT_REQUESTED',
      `${request.requestedBy} aborted failover ${run.id} during ${phase}: ${request.reason}`,
      {
        severity: 'warning',
        failoverId: run.id,
      },
    );
    // Interrupts whatever the failover awaits (an activity, a timer, the replication wait) right away.
    scope.cancel();
    return { failoverId: run.id, abortedDuringPhase: phase };
  }

  private onSetAutoFailover(request: SetAutoFailoverRequest): SetAutoFailoverResult {
    const state = this.state;
    state.autoFailoverEnabled = request.enabled;
    state.autoFailoverSuspendedReason = null;
    if (request.enabled && state.mode === 'MANUAL_INTERVENTION_REQUIRED') {
      state.mode = 'NORMAL';
      state.record('MANUAL_INTERVENTION_RESOLVED', `${request.requestedBy} resumed automatic operation`, {
        severity: 'warning',
      });
    }
    state.record(
      'AUTO_FAILOVER_CHANGED',
      `${request.requestedBy} turned automatic failover ${request.enabled ? 'on' : 'off'}`,
      { severity: request.enabled ? 'info' : 'warning' },
    );
    this.freshestNoted = false;
    if (request.enabled) {
      this.evaluateAutomaticFailover();
    }
    return { autoFailoverEnabled: state.autoFailoverEnabled };
  }

  private onResolveStall(request: ResolveStallRequest): ResolveStallResult {
    const run = this.state.currentFailover;
    if (!run?.stall) {
      throw ApplicationFailure.nonRetryable('No stalled failover is waiting for a decision');
    }
    run.stall.decision = request.decision;
    run.stall.decidedBy = request.requestedBy;
    return { failoverId: run.id, decision: request.decision };
  }

  private onAcknowledgeAlert(request: AcknowledgeAlertRequest): AlertRecord {
    const alert = this.state.alerts.find((candidate) => candidate.id === request.alertId);
    if (!alert) {
      throw ApplicationFailure.nonRetryable(`Unknown alert ${request.alertId}`);
    }
    alert.acknowledgedBy = request.requestedBy;
    alert.acknowledgedAt = nowIso();
    return alert;
  }

  private onRecoverRegion(request: RecoverRegionRequest): RecoverRegionAccepted {
    const recovery: RegionRecovery = {
      id: this.state.nextId('rc'),
      requestedBy: request.requestedBy,
      startedAt: nowIso(),
      phase: 'STARTING_COMPUTE',
      detail: null,
    };
    this.state.recoveries.set(request.regionId, recovery);
    this.state.record('RECOVERY_STARTED', `${request.requestedBy} started recovering ${request.regionId}`, {
      regionId: request.regionId,
    });
    // Runs in the background, outside normal operations: a failover starting meanwhile doesn't cancel it.
    this.spawn(() => recoverRegion(this, request.regionId, recovery));
    return { recoveryId: recovery.id, regionId: request.regionId };
  }

  private async onReconfigure(request: ReconfigureRequest): Promise<ReconfigureResult> {
    if (request.configVersion === this.state.configVersion) {
      return { configVersion: this.state.configVersion };
    }
    // Applied between normal-operations cycles, never in the middle of a failover.
    await condition(
      () => !this.state.currentFailover && !this.pendingTrigger && this.pendingReconfigure === null,
    );
    this.pendingReconfigure = request;
    await condition(() => this.pendingReconfigure === null);
    return { configVersion: this.state.configVersion };
  }

  private applyReconfigure(): void {
    const request = this.pendingReconfigure;
    if (!request) {
      return;
    }
    const previous = this.state.configVersion;
    this.state.config = request.config;
    this.state.configVersion = request.configVersion;
    const ids = new Set(request.config.regions.map((region) => region.id));
    for (const regionId of [...this.state.regionHealth.keys()]) {
      if (!ids.has(regionId)) {
        this.state.regionHealth.delete(regionId);
      }
    }
    for (const region of request.config.regions) {
      if (!this.state.regionCompute.has(region.id)) {
        this.state.regionCompute.set(region.id, 'unknown');
      }
    }
    this.state.record('RECONFIGURED', `Configuration ${previous} → ${request.configVersion} applied`);
    this.pendingReconfigure = null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  private cooldownUntil(): string | null {
    const last = this.state.lastAutomaticFailoverAt;
    if (!last) {
      return null;
    }
    const until = Date.parse(last) + this.state.config.failover.cooldownSeconds * 1000;
    return until > Date.now() ? new Date(until).toISOString() : null;
  }

  private recoveryInProgress(): boolean {
    return [...this.state.recoveries.values()].some(
      (recovery) => recovery.phase === 'STARTING_COMPUTE' || recovery.phase === 'AWAITING_HEALTH',
    );
  }

  /** Tracks a background task so continue-as-new can wait for it. */
  private spawn(task: () => Promise<void>): void {
    const promise: Promise<void> = Promise.resolve()
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        this.backgroundTasks.delete(promise);
      });
    this.backgroundTasks.add(promise);
  }

  /**
   * Waits until nothing would be lost by continuing as new: no alert delivery in flight and no Update half-handled.
   * Returns false when an Update needs the main loop first: a failover or reconfiguration request waits for the
   * main loop, so waiting for it to finish here would deadlock.
   */
  private async readyToContinueAsNew(): Promise<boolean> {
    const info = workflowInfo();
    this.state.record('CONTINUING_AS_NEW', `History reached ${info.historyLength} events; continuing as new`);
    const pendingWork = () => this.pendingTrigger !== null || this.pendingReconfigure !== null;
    await condition(() => (this.backgroundTasks.size === 0 && allHandlersFinished()) || pendingWork());
    if (pendingWork()) {
      this.state.record(
        'CONTINUE_AS_NEW_DEFERRED',
        `A ${this.pendingTrigger ? 'failover' : 'reconfiguration'} was requested meanwhile; serving it first`,
      );
      return false;
    }
    return true;
  }

  private continueAsNewNow(): Promise<never> {
    return continueAsNew<(input: SentryWorkflowInput) => Promise<void>>({
      config: this.state.config,
      configVersion: this.state.configVersion,
      carried: this.state.carry(),
    });
  }
}

/**
 * Like Promise.all, but waits for every promise to settle before rejecting. After a cancellation, this is what makes
 * "the branch has stopped" true: each monitor child has finished cancelling (so its workflow ID can be reused) before
 * the sentry moves on, instead of moving on at the first rejection.
 */
async function settleAll(promises: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    throw failure.reason;
  }
}
