/** Formatting helpers shared by the views: human labels for the sentry's vocabulary, times and durations. */
import type {
  FailoverOutcome,
  FailoverPhase,
  FailoverStepName,
  HealthStatus,
  StepStatus,
} from '@failover-sentry/contracts';

export const STEP_LABELS: Record<FailoverStepName, string> = {
  PRECHECK: 'Pre-flight checks',
  DRAIN_EDGE: 'Drain edge traffic',
  FENCE_OLD_PRIMARY: 'Fence old primary',
  PROMOTE_DATABASE: 'Promote database',
  AWAIT_REPLICATION: 'Await replication webhook',
  VERIFY_PROMOTION: 'Verify promotion',
  SWITCH_EDGE: 'Switch edge routing',
  AWAIT_EDGE_PROPAGATION: 'Await edge propagation',
  STABILIZATION: 'Stabilization watch',
  TAG_RESOURCES: 'Tag cloud resources',
};

export function phaseLabel(phase: FailoverPhase): string {
  if (phase === 'AWAITING_OPERATOR') {
    return 'Waiting for an operator decision';
  }
  if (phase === 'COMPENSATING') {
    return 'Reverting (compensation)';
  }
  if (phase === 'DONE') {
    return 'Done';
  }
  return STEP_LABELS[phase];
}

export const OUTCOME_LABELS: Record<FailoverOutcome, string> = {
  SUCCEEDED: 'Succeeded',
  REVERTED: 'Reverted',
  ABORTED: 'Aborted',
  KEPT_TARGET: 'Kept target',
  MANUAL_INTERVENTION: 'Needs manual intervention',
};

export const STATUS_LABELS: Record<HealthStatus, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  UNHEALTHY: 'Unhealthy',
  UNKNOWN: 'Unknown',
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  PENDING: 'Pending',
  RUNNING: 'In progress',
  SUCCEEDED: 'Done',
  WARNING: 'Done with warnings',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
};

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) {
    return 'never';
  }
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) {
    return 'unknown';
  }
  if (Math.abs(seconds) < 5) {
    return 'just now';
  }
  const future = seconds < 0;
  const abs = Math.abs(seconds);
  const value =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86_400
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86_400)}d`;
  return future ? `in ${value}` : `${value} ago`;
}

export function duration(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!startIso) {
    return '—';
  }
  const end = endIso ? Date.parse(endIso) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(startIso)) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}
