import type { RegionId } from './domain.js';

/** The task queue the sentry's worker polls. */
export const DEFAULT_TASK_QUEUE = 'failover-sentry';

/** The sentry is a singleton per protected service: its workflow ID is derived from the service name. */
export function sentryWorkflowId(serviceName: string): string {
  return `failover-sentry/${serviceName}`;
}

/** Monitor child workflows have stable IDs, so the console can query them and restarts reuse the ID. */
export function monitorWorkflowId(sentryWorkflowIdValue: string, regionId: RegionId): string {
  return `${sentryWorkflowIdValue}/monitor/${regionId}`;
}

/** Header carrying the HMAC signature of signed requests (webhooks and admin APIs). */
export const SIGNATURE_HEADER = 'x-sentry-signature';

/** Header the console requires on state-changing API calls (a CSRF defence: cross-site forms can't set it). */
export const CSRF_HEADER = 'x-sentry-csrf';

/** Response headers the edge router adds, so probes through the edge can tell who served them. */
export const EDGE_REGION_HEADER = 'x-sentry-region';
export const EDGE_EPOCH_HEADER = 'x-sentry-epoch';

/** Paths of the regional workload's admin API. */
export const REGIONAL_PATHS = {
  health: '/healthz',
  /** Process liveness for the container platform. Chaos never touches it, so the platform can't "heal" an outage. */
  liveness: '/livez',
  dbStatus: '/internal/db/status',
  promote: '/internal/db/promote',
  demote: '/internal/db/demote',
  chaos: '/internal/chaos',
  power: '/internal/power',
} as const;

/** Path of the edge router's routing endpoint (GET reads, signed PUT writes). */
export const EDGE_ROUTING_PATH = '/__edge/routing';

/** Path of the console's replication webhook. */
export const REPLICATION_WEBHOOK_PATH = '/api/webhooks/replication';

/** Bounded collections in the sentry's state: workflow state must stay small. */
export const LIMITS = {
  alerts: 25,
  timeline: 120,
  recentFailovers: 10,
  processedEventIds: 200,
  monitorProbeHistory: 40,
} as const;
