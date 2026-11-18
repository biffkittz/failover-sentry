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
 *
 * Reading guide (how control flows through this file):
 *
 *   failoverSentryWorkflow (workflows/index.ts) → new Sentry(input).run()
 *     run()                    registers the handlers, discovers the edge on a first start, then mainLoop()
 *     mainLoop()               forever: runNormalOperations() → act on its exit reason
 *       runNormalOperations()  superviseMonitors() + reconcileLoop() in a cancellable scope, until exitReason()
 *       runFailover()          FailoverExecution.execute() (failover.ts), compensate() if it throws
 *       applyReconfigure()     swaps in a new configuration
 *       readyToContinueAsNew() / continueAsNewNow()
 *
 *   Things that set an exit reason (and so end normal operations):
 *     onHealthReport → evaluateAutomaticFailover   automatic failover          (pendingTrigger)
 *     reconcile('failover-to-freshest')             automatic planned failover  (pendingTrigger)
 *     onTriggerFailover                             operator's failover Update  (pendingTrigger)
 *     onReconfigure                                 worker bootstrap's Update   (pendingReconfigure)
 *     workflowInfo().continueAsNewSuggested         the history grew long
 *
 * Determinism: everything here is workflow code. It runs again on replay, so it may only use workflow APIs
 * (activities, timers, conditions, child workflows), workflow time and the pure functions in domain/. A change to
 * the commands it issues must be guarded with patched() (see the PATCH_ constants and docs/WORKFLOWS.md).
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

/** Why runNormalOperations() returned, and so what mainLoop() does next. Produced by exitReason(). */
type NormalOperationsExit =
  { kind: 'failover'; trigger: FailoverTrigger } | { kind: 'reconfigure' } | { kind: 'continue-as-new' };

/**
 * History length at which the sentry continues as new even if the server hasn't suggested it yet (Temporal's hard
 * limit is 51 200 events; the server normally suggests continuing well before this). Read by exitReason().
 */
const MAX_HISTORY_EVENTS = 20_000;

/**
 * Patch: after a failover, decide only on health reports observed after it ended (see SentryState.healthValidSince).
 * Histories recorded before it replay as they ran.
 */
export const PATCH_FRESH_HEALTH_AFTER_FAILOVER = 'fresh-health-after-failover';

/** Patch: stop the monitors by workflow ID, reaching their current run (see stopMonitors). */
export const PATCH_CANCEL_MONITORS_BY_ID = 'cancel-monitors-by-workflow-id';

/** Patch: when the sentry itself is cancelled, stop its monitors by workflow ID before ending. */
export const PATCH_STOP_MONITORS_ON_CANCEL = 'stop-monitors-on-cancel';

/**
 * One instance per workflow run. It implements FailoverHost, the small interface FailoverExecution (failover.ts)
 * and recoverRegion (recovery.ts) use to reach back into the sentry: its state, alerts, edge writes and probes.
 */
export class Sentry implements FailoverHost {
  /**
   * Everything the sentry knows and has done (epoch, active region, region health, failovers, alerts, timeline).
   * Query handlers read it, handlers and branches change it, and it is carried across continue-as-new.
   */
  readonly state: SentryState;
  /**
   * A failover that has been decided or requested but hasn't started yet. Set by evaluateAutomaticFailover(),
   * reconcile('failover-to-freshest') and onTriggerFailover(); read by exitReason() (which then ends normal
   * operations); cleared by runFailover() once currentFailover takes over as the guard. While it is set, validators
   * and the automatic decision refuse a second failover.
   */
  private pendingTrigger: FailoverTrigger | null = null;
  /** A configuration waiting to be applied between normal-operations cycles. Set by onReconfigure(). */
  private pendingReconfigure: ReconfigureRequest | null = null;
  /** The running failover's cancellation scope, which onAbortFailover() cancels. Null outside a failover. */
  private failoverScope: CancellationScope | null = null;
  /** Work started with spawn() (alert deliveries, region recoveries) that continue-as-new must wait for. */
  private readonly backgroundTasks = new Set<Promise<void>>();
  /** Regions whose monitor child has started (and not ended): the ones stopMonitors has to reach. */
  private readonly startedMonitors = new Set<RegionId>();
  /** The last failover to finish, so onTriggerFailover() can answer even if its failover ended very quickly. */
  private lastFinishedFailoverId: string | null = null;
  /** Report-once flags: each condition is recorded or alerted once, not on every health report. */
  private noTargetAlerted = false;
  private cooldownNoted = false;
  private freshestNoted = false;

  /** Called once per run by failoverSentryWorkflow (workflows/index.ts); restores carried state on continue-as-new. */
  constructor(input: SentryWorkflowInput) {
    this.state = new SentryState(input);
  }

  /**
   * The workflow's body: called once per run, right after the constructor, and never returns normally (the sentry
   * runs until cancelled, terminated or continued as new). Registers the signal, query and Update handlers first, so
   * nothing that arrives with the first workflow task is lost; on a first start (not a continue-as-new) it adopts the
   * edge's routing; then it hands over to mainLoop().
   *
   * If the sentry itself is cancelled, the cancellation surfaces here as a CancelledFailure: it stops the monitors by
   * workflow ID (in a non-cancellable scope, since the workflow's own scope is already cancelled) and rethrows, which
   * ends the run as Cancelled.
   */
  async run(): Promise<never> {
    this.registerHandlers();
    if (this.state.resumed) {
      this.state.record('CONTINUED_AS_NEW', `Run ${this.state.continuedAsNewCount} of the sentry started`);
    } else {
      await this.discover();
    }
    try {
      return await this.mainLoop();
    } catch (error) {
      if (isCancellation(error) && patched(PATCH_STOP_MONITORS_ON_CANCEL)) {
        // The sentry itself was cancelled. Its monitors get the child cancellation too, but one that has continued
        // as new misses it (and would keep probing for a sentry that is gone): stop them by workflow ID.
        await CancellationScope.nonCancellable(() => this.stopMonitors());
      }
      throw error;
    }
  }

  /**
   * The sentry's top-level loop, called once by run(). Each iteration runs normal operations until something ends
   * them, then takes the branch their exit reason calls for, and goes round again. It only returns by continuing as
   * new (continueAsNewNow() never resolves: the run ends there).
   */
  private async mainLoop(): Promise<never> {
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

  /**
   * Called by run() on a first start only (a continued-as-new run carries all this in its state).
   *
   * Adopts whatever the edge already routes to, since the edge is where traffic really goes: its active region, and
   * its epoch and write version as floors (so the sentry's next edge write is newer than the stored one and isn't
   * refused as stale). That makes starting a new sentry over a running deployment safe, after a termination for
   * example. An empty or unreachable edge is recorded, and reconciliation establishes routing later.
   */
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

  /**
   * One normal-operations cycle, called by mainLoop() at the start of every iteration (after a failover or a
   * reconfiguration too, which is how the monitors come back).
   *
   * Starts the monitors and the reconciler inside a fresh cancellable scope, then waits until exitReason() names a
   * reason to leave. To leave, it stops the monitors by workflow ID (see stopMonitors), cancels the scope, which
   * cancels the monitor children, the reconciler's timers and any activity in flight, and waits until all of it has
   * really stopped before returning the reason. A cancellation of that background work is expected; any other error
   * fails the workflow task.
   */
  private async runNormalOperations(): Promise<NormalOperationsExit> {
    const scope = new CancellationScope();
    const background = scope.run(() => settleAll([this.superviseMonitors(), this.reconcileLoop()]));
    // Handled from the start: if the whole workflow is cancelled, the wait below rejects first and this promise is
    // never awaited, and an unhandled rejection fails every workflow task (the sentry could never finish).
    background.catch(() => undefined);

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

  /**
   * Why normal operations should end, or null to keep going. Polled by runNormalOperations()'s condition, which
   * Temporal re-evaluates after every activation (each signal, Update, timer or activity result). In order of
   * precedence: a pending failover, a pending reconfiguration, then a long history (unless a region recovery is in
   * progress: it waits on health reports, which continuing as new would interrupt).
   */
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

  /**
   * Started by runNormalOperations() inside its scope: one supervisor per configured region, running until the
   * scope is cancelled. settleAll waits for every supervisor to finish cancelling before it rejects.
   */
  private async superviseMonitors(): Promise<void> {
    await settleAll(this.state.config.regions.map((region) => this.superviseMonitor(region)));
  }

  /**
   * Keeps one region's monitor child (monitor-region.ts) running for as long as normal operations last; called by
   * superviseMonitors(). Starts the child, waits for it to end, and restarts it with exponential backoff (2 s up to
   * 60 s) if it ever ends or fails on its own. A monitor ends by itself only if it can't signal the sentry.
   *
   * If the start fails because a monitor with the same workflow ID is still running (one left over from an earlier
   * run of the sentry, say), it cancels that one by workflow ID and tries again after the backoff. The scope's
   * cancellation surfaces as a CancelledFailure, which it rethrows: that is how the supervisor stops.
   */
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
   *
   * Called by runNormalOperations() just before it cancels its scope, and by run() when the sentry itself is
   * cancelled. Failures are ignored: a monitor that has already ended needs no stopping.
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

  /**
   * Keeps reality in line with the sentry's intent, one corrective action at a time. Started by
   * runNormalOperations() inside its scope, next to the monitors, and stopped when that scope is cancelled.
   *
   * It waits until reconciliationPlan() has something to do (the condition is re-evaluated whenever state changes,
   * typically when a health report arrives), runs it with reconcile(), then sleeps for two probe intervals so the
   * monitors can observe the effect before it plans again. The sleep doubles after each consecutive failure, up to
   * 5 minutes.
   */
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

  /**
   * The next corrective action, or null when everything is as intended. Evaluated by reconcileLoop()'s condition.
   * Never plans during a failover or while one is pending. Delegates to the pure planReconciliation()
   * (domain/decisions.ts), which uses only health observed since the last failover ended. A "failover to the
   * freshest region" that can't run because automatic failover is off is reported once (freshestNoted), not on
   * every evaluation.
   */
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

  /**
   * Carries out one action from reconciliationPlan(); called by reconcileLoop(). Each action:
   *
   * - fence-stale-primary: a region other than the active one claims to be primary (split brain). Demotes it at
   *   the current epoch and raises a critical alert.
   * - restore-active-primary: no database is primary (a first start, or the active region came back empty).
   *   Promotes the active region's database under a new epoch above any epoch seen, then verifies it.
   * - failover-to-freshest: the active region came back empty while a standby holds newer data. Requests an
   *   automatic planned failover to that standby (sets pendingTrigger), or records it if automatic failover is off.
   * - sync-edge: the edge doesn't route to the active region at the current epoch. Rewrites the routing.
   *
   * A database refusing the order because it holds a newer epoch makes the sentry adopt that epoch and throw, so the
   * next attempt carries an epoch the node will accept. reconcileLoop() records the failure and backs off.
   */
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

  /**
   * The failover branch, called by mainLoop() when normal operations ended for a failover; the monitors and the
   * reconciler have stopped by then.
   *
   * Takes a new epoch (every authority change does), creates the FailoverRun the console follows, and runs the
   * failover's steps (FailoverExecution.execute(), failover.ts) in their own cancellable scope, which
   * onAbortFailover() can cancel. Then:
   *
   * - On success, the target becomes the active region.
   * - On any failure or abort, it compensates in a non-cancellable scope (cleanup must finish even though the
   *   failover's scope was cancelled) and reports the outcome with reportOutcome().
   *
   * Either way the finally block archives the run, returns to NORMAL mode, and sets healthValidSince, so that later
   * decisions ignore health observed under the old roles (patched: histories from before replay without it).
   */
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

  /**
   * Raises the alert for a failover that didn't succeed; called by runFailover() after compensation. Each outcome
   * has its own alert. MANUAL_INTERVENTION also puts the sentry in MANUAL_INTERVENTION_REQUIRED mode and suspends
   * automatic failover, until an operator turns it back on (onSetAutoFailover).
   */
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

  /**
   * Records an alert in the state (the console shows it at once) and delivers it in the background (email, or the
   * log). Part of FailoverHost: called from this file, from FailoverExecution (failover.ts) and from recoverRegion
   * (recovery.ts). Returns immediately; delivery never blocks the caller.
   */
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

  /**
   * Sends one alert through the sendAlert activity and records how it went on the alert itself. Spawned by
   * raiseAlert(). Runs in a non-cancellable scope, so aborting a failover (or cancelling normal operations) doesn't
   * swallow the alert that reports it. A delivery failure is recorded, never thrown.
   */
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

  /**
   * Writes the edge router's routing through the setEdgeRouting activity, with the given epoch and the next write
   * version, so the edge can order writes and refuse old ones. Part of FailoverHost: called by FailoverExecution to
   * drain the edge, switch it, and route it back during compensation, and by reconcile('sync-edge').
   *
   * If the edge refuses the write as stale (it holds a newer epoch or version), the sentry adopts what the edge
   * holds and throws a non-retryable StaleEpoch failure: a newer authority exists, and the caller must not retry
   * with the same epoch.
   */
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

  /**
   * One live health probe of a region (a local activity with the policy's probe timeout). Part of FailoverHost: used
   * by FailoverExecution's precheck (is the target healthy, and replicating?) and by its compensation (can the old
   * primary still serve?). Never throws for an unhealthy region: a failed probe comes back as data.
   */
  probeRegion(regionId: RegionId): Promise<ProbeResult> {
    const timeoutMs = this.state.config.health.probeTimeoutMs;
    return probeActivities(timeoutMs).probeRegion({ regionId, timeoutMs });
  }

  /**
   * One probe through the public edge host name, the way users reach the service; it reports which region served it.
   * Part of FailoverHost: used by FailoverExecution's stabilization step after a switch.
   */
  probeEdge(): Promise<EdgeProbeResult> {
    const timeoutMs = this.state.config.health.probeTimeoutMs;
    return probeActivities(timeoutMs).probeEdge({ timeoutMs });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Registers every query, signal and Update handler; called once by run(), before anything else, so messages that
   * arrive with the run's first workflow task are handled.
   *
   * Each Update gets a validator (validators.ts). Validators run before the Update is accepted, and a validator that
   * throws rejects it without any trace in the history; the console shows its message. They aren't run again on
   * replay. Handlers only run for accepted Updates. The query handler builds the view the console shows; it must not
   * change state.
   */
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

  /**
   * Handles the regionHealthReport signal, sent by a region's monitor child when its verdict or its database changes,
   * on its first probe, and every reportEveryProbes probes.
   *
   * Drops reports that are duplicated or out of order (same monitor instance, sequence not newer), stores the
   * snapshot, marks the region's compute as running if it answers, records notable changes in the timeline, then
   * reconsiders an automatic failover. The reconciler's condition sees the new snapshot too, without being called
   * from here.
   */
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

  /**
   * Decides whether to fail over automatically; called on every health report (onHealthReport) and when an operator
   * turns automatic failover back on (onSetAutoFailover). Does nothing unless the sentry is in NORMAL mode, no
   * failover is running or pending, and automatic failover is enabled.
   *
   * The decision itself is the pure decideAutomaticFailover() (domain/decisions.ts). A failover decision sets
   * pendingTrigger, which ends normal operations. Cooldown and "no healthy target" are reported once, until the
   * primary recovers (decision 'none' resets the flags) or a failover ends.
   */
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

  /**
   * Handles the replicationComplete signal, which the console's webhook gateway sends when a region reports that its
   * promotion completed or failed. FailoverExecution's AWAIT_REPLICATION step waits for the run.replication field
   * this sets (failover.ts).
   *
   * Ignores redeliveries (event IDs are remembered across continue-as-new) and events for another failover, another
   * region or an older epoch. Only the first valid confirmation counts.
   */
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

  /**
   * Handles the triggerFailover Update: the console's emergency failover button (or a planned failover an operator
   * requests). Runs only after validateTriggerFailover() accepted it.
   *
   * Resolves the target (the requested region, or the best standby), sets pendingTrigger (which ends normal
   * operations), and then waits until the failover branch has taken over before answering. The console therefore
   * learns the failover's ID and epoch as soon as it has really started; it follows the rest through the state stream.
   */
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

  /**
   * Handles the abortFailover Update (the console's Abort button), after validateAbortFailover() accepted it.
   * Cancels the running failover's scope: whatever the failover is awaiting rejects at once, and runFailover()
   * compensates.
   */
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

  /**
   * Handles the setAutoFailover Update (the console's automatic-failover toggle). Turning it on also clears a
   * MANUAL_INTERVENTION_REQUIRED mode (the operator says the situation is resolved) and re-evaluates an automatic
   * failover at once, rather than waiting for the next health report.
   */
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

  /**
   * Handles the resolveStall Update: the operator's answer (keep waiting, retry as forced, or abort) when replica sync
   * stalled. Validated by validateResolveStall(). It only records the decision on the run's stall;
   * FailoverExecution.awaitReplication() (failover.ts) is waiting on that field and acts on it.
   */
  private onResolveStall(request: ResolveStallRequest): ResolveStallResult {
    const run = this.state.currentFailover;
    if (!run?.stall) {
      throw ApplicationFailure.nonRetryable('No stalled failover is waiting for a decision');
    }
    run.stall.decision = request.decision;
    run.stall.decidedBy = request.requestedBy;
    return { failoverId: run.id, decision: request.decision };
  }

  /** Handles the acknowledgeAlert Update (the console's Acknowledge button): records who acknowledged an alert. */
  private onAcknowledgeAlert(request: AcknowledgeAlertRequest): AlertRecord {
    const alert = this.state.alerts.find((candidate) => candidate.id === request.alertId);
    if (!alert) {
      throw ApplicationFailure.nonRetryable(`Unknown alert ${request.alertId}`);
    }
    alert.acknowledgedBy = request.requestedBy;
    alert.acknowledgedAt = nowIso();
    return alert;
  }

  /**
   * Handles the recoverRegion Update (the console's Recover button), after validateRecoverRegion() accepted it.
   * Records a recovery and runs recoverRegion() (recovery.ts) in the background, which starts the region's compute
   * and waits for it to report healthy as a replica. Answers at once with the recovery's ID; the console follows the
   * recovery's phase in the state. Spawned outside normal operations, so a failover starting meanwhile doesn't
   * cancel it.
   */
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

  /**
   * Handles the reconfigure Update, which the worker's bootstrap (bootstrap.ts) sends when it starts with a
   * configuration whose version differs from the running sentry's (after a Terraform change, say). Validated by
   * validateReconfigure().
   *
   * The same version is a no-op. Otherwise it waits until no failover is running or pending, hands the request to the
   * main loop (pendingReconfigure, which ends normal operations), and answers once applyReconfigure() has applied it.
   */
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

  /**
   * Applies a pending configuration; called by mainLoop() between normal-operations cycles, so the monitors restart
   * with the new regions and health policy. Forgets the health of regions that were removed, adds compute state for
   * new ones, and clears pendingReconfigure, which completes the waiting onReconfigure() Update.
   */
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

  /**
   * When the cooldown after the last automatic failover ends, or null when none is in force. Only for the console:
   * the query handler includes it in the state view. The decision itself checks the cooldown in
   * decideAutomaticFailover().
   */
  private cooldownUntil(): string | null {
    const last = this.state.lastAutomaticFailoverAt;
    if (!last) {
      return null;
    }
    const until = Date.parse(last) + this.state.config.failover.cooldownSeconds * 1000;
    return until > Date.now() ? new Date(until).toISOString() : null;
  }

  /**
   * Whether a region recovery is still under way. exitReason() defers continue-as-new while one is: the recovery
   * waits for health reports, and continuing as new would cut it off.
   */
  private recoveryInProgress(): boolean {
    return [...this.state.recoveries.values()].some(
      (recovery) => recovery.phase === 'STARTING_COMPUTE' || recovery.phase === 'AWAITING_HEALTH',
    );
  }

  /**
   * Starts work that runs alongside the main loop instead of inside it, and tracks it in backgroundTasks so
   * continue-as-new can wait for it. Used by raiseAlert() (alert delivery) and onRecoverRegion() (region recovery).
   * The task inherits the scope current at the call; work that must survive cancellation enters a non-cancellable
   * scope itself (as deliver() does). Errors are swallowed: a background task reports its own failures.
   */
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
   *
   * Called by mainLoop() when normal operations ended because the history grew long. By then the monitors and the
   * reconciler have stopped. On false, mainLoop() goes round again: it serves the request, and normal operations
   * choose to continue as new again afterwards.
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

  /**
   * Ends this run and starts a fresh one with an empty history, carrying the configuration and SentryState.carry()
   * (epoch, active region, edge routing, region health and compute, alerts, timeline, recent failovers, processed
   * webhook IDs, ID sequence). Called by mainLoop() once readyToContinueAsNew() allowed it. The returned promise
   * never resolves: the SDK ends the run.
   */
  private continueAsNewNow(): Promise<never> {
    return continueAsNew<(input: SentryWorkflowInput) => Promise<void>>({
      config: this.state.config,
      configVersion: this.state.configVersion,
      carried: this.state.carry(),
    });
  }
}

/**
 * Used by runNormalOperations() (monitors and reconciler) and superviseMonitors() (one supervisor per region).
 *
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
