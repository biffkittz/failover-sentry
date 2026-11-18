/**
 * The sentry's Temporal message definitions. Workflows register handlers for them; the console's server and the
 * worker's bootstrapper use the same objects to send them, so names and payload types can't drift apart.
 */
import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type { MonitorStateView, RegionHealthReport, SentryStateView } from './domain.js';
import type {
  AbortFailoverRequest,
  AbortFailoverResult,
  AcknowledgeAlertRequest,
  AcknowledgeAlertResult,
  FailoverAccepted,
  ManualFailoverRequest,
  ReconfigureRequest,
  ReconfigureResult,
  RecoverRegionAccepted,
  RecoverRegionRequest,
  ReplicationCompleteSignalPayload,
  ResolveStallRequest,
  ResolveStallResult,
  SetAutoFailoverRequest,
  SetAutoFailoverResult,
} from './messages.js';

// Signals -------------------------------------------------------------------------------------------------------------

/** Monitor child -> sentry: a region's health changed, or a periodic report is due. */
export const regionHealthReportSignal = defineSignal<[RegionHealthReport]>('regionHealthReport');

/** Webhook gateway -> sentry: a region's database finished (or failed) its promotion. */
export const replicationCompleteSignal =
  defineSignal<[ReplicationCompleteSignalPayload]>('replicationComplete');

// Queries -------------------------------------------------------------------------------------------------------------

export const getSentryStateQuery = defineQuery<SentryStateView>('getSentryState');

export const getMonitorStateQuery = defineQuery<MonitorStateView>('getMonitorState');

// Updates (validated, acknowledged operator actions) ---------------------------------------------------------------

/** The emergency failover button. Returns once the failover has started, not when it ends. */
export const triggerFailoverUpdate = defineUpdate<FailoverAccepted, [ManualFailoverRequest]>(
  'triggerFailover',
);

export const abortFailoverUpdate = defineUpdate<AbortFailoverResult, [AbortFailoverRequest]>('abortFailover');

export const setAutoFailoverUpdate = defineUpdate<SetAutoFailoverResult, [SetAutoFailoverRequest]>(
  'setAutoFailover',
);

export const resolveStallUpdate = defineUpdate<ResolveStallResult, [ResolveStallRequest]>('resolveStall');

export const acknowledgeAlertUpdate = defineUpdate<AcknowledgeAlertResult, [AcknowledgeAlertRequest]>(
  'acknowledgeAlert',
);

/** Start a fenced (stopped) region again and let it rejoin as a replica. */
export const recoverRegionUpdate = defineUpdate<RecoverRegionAccepted, [RecoverRegionRequest]>(
  'recoverRegion',
);

/** Apply new configuration at the next safe point (between normal-operations cycles). */
export const reconfigureUpdate = defineUpdate<ReconfigureResult, [ReconfigureRequest]>('reconfigure');
