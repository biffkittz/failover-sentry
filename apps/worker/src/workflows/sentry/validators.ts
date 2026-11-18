/**
 * The sentry's Update validators: pure checks of a request against the sentry's state. A validator that throws
 * rejects the Update before it reaches the workflow history, and the operator sees its message.
 */
import type {
  AbortFailoverRequest,
  AcknowledgeAlertRequest,
  ManualFailoverRequest,
  ReconfigureRequest,
  RecoverRegionRequest,
  RegionId,
  ResolveStallRequest,
} from '@failover-sentry/contracts';
import { chooseFailoverTarget } from '../../domain/decisions.js';
import type { SentryState } from './state.js';

export function requireActor(requestedBy: string | undefined): void {
  if (!requestedBy?.trim()) {
    throw new Error('requestedBy is required');
  }
}

/** `failoverPending`: a failover was requested or decided but hasn't started yet. */
export function validateTriggerFailover(
  state: SentryState,
  request: ManualFailoverRequest,
  failoverPending: boolean,
): void {
  requireActor(request.requestedBy);
  if (state.currentFailover || failoverPending || state.mode === 'FAILING_OVER') {
    throw new Error('A failover is already in progress');
  }
  if (request.mode !== 'planned' && request.mode !== 'forced') {
    throw new Error('mode must be "planned" or "forced"');
  }
  const reason = request.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 500) {
    throw new Error('reason must be 3 to 500 characters');
  }
  resolveManualTarget(state, request);
}

/** The region a manual failover goes to: the requested one if it qualifies, else the best standby. */
export function resolveManualTarget(state: SentryState, request: ManualFailoverRequest): RegionId {
  const targetId = request.targetRegionId;
  if (targetId) {
    if (!state.region(targetId)) {
      throw new Error(`Unknown region "${targetId}"`);
    }
    if (targetId === state.activeRegionId) {
      throw new Error(`${targetId} is already the primary`);
    }
    const compute = state.regionCompute.get(targetId);
    if (compute === 'stopped' || compute === 'starting') {
      throw new Error(`${targetId}'s compute is ${compute}; recover the region first`);
    }
    const status = state.regionHealth.get(targetId)?.status ?? 'UNKNOWN';
    if (request.mode === 'planned' && status !== 'HEALTHY') {
      throw new Error(
        `A planned failover needs a HEALTHY target, and ${targetId} is ${status}. A forced failover overrides this.`,
      );
    }
    return targetId;
  }
  const choice = chooseFailoverTarget(state.decisionContext(), { allowDegraded: request.mode === 'forced' });
  if (!choice.regionId) {
    throw new Error(`No eligible failover target: ${choice.reason}`);
  }
  return choice.regionId;
}

/** `abortable`: the failover's cancellation scope is live. */
export function validateAbortFailover(
  state: SentryState,
  request: AbortFailoverRequest,
  abortable: boolean,
): void {
  requireActor(request.requestedBy);
  const run = state.currentFailover;
  if (!run || !abortable) {
    throw new Error('No failover is in progress');
  }
  if (run.phase === 'COMPENSATING' || run.phase === 'DONE') {
    throw new Error('The failover is already being reverted');
  }
}

export function validateResolveStall(state: SentryState, request: ResolveStallRequest): void {
  requireActor(request.requestedBy);
  const run = state.currentFailover;
  if (!run || run.phase !== 'AWAITING_OPERATOR' || !run.stall || run.stall.decision !== null) {
    throw new Error('No stalled failover is waiting for a decision');
  }
  if (!['keep-waiting', 'retry-forced', 'abort'].includes(request.decision)) {
    throw new Error('decision must be keep-waiting, retry-forced or abort');
  }
}

export function validateAcknowledgeAlert(state: SentryState, request: AcknowledgeAlertRequest): void {
  requireActor(request.requestedBy);
  const alert = state.alerts.find((candidate) => candidate.id === request.alertId);
  if (!alert) {
    throw new Error(`Unknown alert ${request.alertId}`);
  }
  if (alert.acknowledgedBy) {
    throw new Error(`Alert ${request.alertId} was already acknowledged by ${alert.acknowledgedBy}`);
  }
}

export function validateRecoverRegion(state: SentryState, request: RecoverRegionRequest): void {
  requireActor(request.requestedBy);
  const region = state.region(request.regionId);
  if (!region) {
    throw new Error(`Unknown region "${request.regionId}"`);
  }
  if (request.regionId === state.activeRegionId) {
    throw new Error(`${request.regionId} is the primary; only a standby can be recovered`);
  }
  if (state.currentFailover?.fromRegionId === request.regionId) {
    throw new Error(`${request.regionId} is the source of the failover in progress`);
  }
  const recovery = state.recoveries.get(request.regionId);
  if (recovery && (recovery.phase === 'STARTING_COMPUTE' || recovery.phase === 'AWAITING_HEALTH')) {
    throw new Error(`${request.regionId} is already being recovered`);
  }
  const compute = state.regionCompute.get(request.regionId);
  const status = state.regionHealth.get(request.regionId)?.status;
  if (compute !== 'stopped' && status !== 'UNHEALTHY') {
    throw new Error(`${request.regionId} is neither stopped nor unhealthy; there is nothing to recover`);
  }
}

export function validateReconfigure(state: SentryState, request: ReconfigureRequest): void {
  if (!request.configVersion) {
    throw new Error('configVersion is required');
  }
  const ids = request.config.regions.map((region) => region.id);
  if (ids.length < 2) {
    throw new Error('A failover needs at least two regions');
  }
  if (!ids.includes(state.activeRegionId)) {
    throw new Error(
      `The new configuration drops ${state.activeRegionId}, the current primary; fail over first`,
    );
  }
}
