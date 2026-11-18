/**
 * monitorRegionChild: one per region, started by the sentry as a child workflow.
 *
 * It owns the region's polling loop (probe, evaluate the rolling window, sleep), isolated from the other regions and
 * from the sentry's own history. It reports to the sentry by signal only when something changed (or periodically),
 * so the sentry aggregates verdicts instead of raw probes. The console can query it for the probe history.
 *
 * Cancellation: the sentry starts monitors inside its "normal operations" cancellation scope. Cancelling that scope
 * cancels this workflow, which interrupts whatever it awaits (the probe or the sleep timer) and ends it; no timer is
 * left behind.
 */
import {
  LIMITS,
  type HealthPolicy,
  type HealthReportReason,
  type HealthStatus,
  type MonitorStateView,
  type ProbeResult,
  type RegionConfig,
  type RegionHealthSnapshot,
  type RegionRole,
} from '@failover-sentry/contracts';
import { getMonitorStateQuery, regionHealthReportSignal } from '@failover-sentry/contracts/temporal';
import {
  continueAsNew,
  getExternalWorkflowHandle,
  isCancellation,
  log,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { databaseKey, evaluateHealth } from '../domain/health.js';
import { probeActivities } from './activities.js';

export interface MonitorInput {
  sentryWorkflowId: string;
  region: RegionConfig;
  role: RegionRole;
  policy: HealthPolicy;
  carried?: MonitorCarriedState | undefined;
}

export interface MonitorCarriedState {
  probes: ProbeResult[];
  sequence: number;
  lastReportedStatus: HealthStatus | null;
  lastReportedDatabaseKey: string | null;
  probesSinceReport: number;
  startedAt: string;
  iterations: number;
  continuedAsNewCount: number;
}

/** Bounds each run's history; the chain continues as new with its window carried over. */
export const MONITOR_ITERATIONS_PER_RUN = 300;

export async function monitorRegionChild(input: MonitorInput): Promise<void> {
  const { region, policy } = input;
  const state: MonitorCarriedState = input.carried
    ? { ...input.carried, continuedAsNewCount: input.carried.continuedAsNewCount + 1 }
    : {
        probes: [],
        sequence: 0,
        lastReportedStatus: null,
        lastReportedDatabaseKey: null,
        probesSinceReport: 0,
        startedAt: new Date().toISOString(),
        iterations: 0,
        continuedAsNewCount: 0,
      };
  const monitorInstanceId = workflowInfo().firstExecutionRunId;
  const { probeRegion } = probeActivities(policy.probeTimeoutMs);
  const sentry = getExternalWorkflowHandle(input.sentryWorkflowId);

  setHandler(getMonitorStateQuery, (): MonitorStateView => {
    const assessment = evaluateHealth(state.probes, policy);
    return {
      regionId: region.id,
      role: input.role,
      status: assessment.status,
      probes: state.probes,
      consecutiveFailures: assessment.consecutiveFailures,
      startedAt: state.startedAt,
      iterations: state.iterations,
      continuedAsNewCount: state.continuedAsNewCount,
    };
  });

  let iterationsThisRun = 0;
  for (;;) {
    const probe = await probeRegion({ regionId: region.id, timeoutMs: policy.probeTimeoutMs });
    state.probes.push(probe);
    if (state.probes.length > LIMITS.monitorProbeHistory) {
      state.probes.splice(0, state.probes.length - LIMITS.monitorProbeHistory);
    }
    state.iterations += 1;
    state.probesSinceReport += 1;
    iterationsThisRun += 1;

    const assessment = evaluateHealth(state.probes, policy);
    const dbKey = databaseKey(probe);
    const reason = reportReason(state, assessment.status, dbKey, policy);
    if (reason) {
      state.sequence += 1;
      const snapshot: RegionHealthSnapshot = {
        regionId: region.id,
        ...assessment,
        lastProbe: probe,
        observedAt: new Date().toISOString(),
        monitorInstanceId,
        sequence: state.sequence,
      };
      try {
        await sentry.signal(regionHealthReportSignal, { reason, snapshot });
        state.lastReportedStatus = assessment.status;
        state.lastReportedDatabaseKey = dbKey;
        state.probesSinceReport = 0;
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        // The sentry is gone (terminated, or a bug): a monitor without a sentry has no purpose.
        log.warn('Could not report to the sentry; stopping this monitor', {
          region: region.id,
          error: (error as Error).message,
        });
        return;
      }
    }

    if (iterationsThisRun >= MONITOR_ITERATIONS_PER_RUN || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof monitorRegionChild>({ ...input, carried: state });
    }
    await sleep(policy.probeIntervalSeconds * 1000);
  }
}

function reportReason(
  state: MonitorCarriedState,
  status: HealthStatus,
  dbKey: string | null,
  policy: HealthPolicy,
): HealthReportReason | null {
  if (state.lastReportedStatus === null) {
    return 'FIRST_PROBE';
  }
  if (status !== state.lastReportedStatus) {
    return 'STATUS_CHANGED';
  }
  if (dbKey !== null && dbKey !== state.lastReportedDatabaseKey) {
    return 'DATABASE_CHANGED';
  }
  if (state.probesSinceReport >= policy.reportEveryProbes) {
    return 'PERIODIC';
  }
  return null;
}
