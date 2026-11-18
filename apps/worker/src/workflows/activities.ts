/**
 * Activity proxies with their timeouts and retry policies. Each group's options say what failure means for it:
 * probes never retry (a failure is the measurement), control-plane orders retry briefly, verifications poll through
 * retries, and alerts try hard.
 */
import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow';
import type { SentryActivities } from '../activities/index.js';

/** Health probes run as local activities: frequent, short, and cheaper in history than regular activities. */
export function probeActivities(timeoutMs: number) {
  return proxyLocalActivities<Pick<SentryActivities, 'probeRegion' | 'probeEdge'>>({
    startToCloseTimeout: timeoutMs + 3_000,
    retry: { maximumAttempts: 1 },
  });
}

/** Orders to databases and the edge: retried a few times, never past a fencing refusal or a bad request. */
export const control = proxyActivities<
  Pick<
    SentryActivities,
    'getDatabaseStatus' | 'demoteDatabase' | 'requestDatabasePromotion' | 'getEdgeRouting' | 'setEdgeRouting'
  >
>({
  startToCloseTimeout: '20 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    maximumAttempts: 4,
    nonRetryableErrorTypes: ['NonRetryableHttpError'],
  },
});

/** A single quick attempt, for questions whose answer is "unreachable" just as often as not. */
export const quickCheck = proxyActivities<Pick<SentryActivities, 'getDatabaseStatus'>>({
  startToCloseTimeout: '8 seconds',
  retry: { maximumAttempts: 1 },
});

/** Polls through retries until the database reports primary, for at most three minutes. */
export const verification = proxyActivities<Pick<SentryActivities, 'verifyDatabasePrimary'>>({
  startToCloseTimeout: '15 seconds',
  scheduleToCloseTimeout: '3 minutes',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 1.5,
    maximumInterval: '10 seconds',
    nonRetryableErrorTypes: ['NonRetryableHttpError'],
  },
});

/** Polls the edge inside one long, heartbeating attempt; cancellation reaches it through the heartbeat. */
export function edgePropagation(timeoutSeconds: number) {
  return proxyActivities<Pick<SentryActivities, 'verifyEdgeRouting'>>({
    startToCloseTimeout: `${timeoutSeconds + 30} seconds`,
    heartbeatTimeout: '20 seconds',
    retry: {
      maximumAttempts: 2,
      nonRetryableErrorTypes: ['EdgePropagationTimeout', 'NonRetryableHttpError'],
    },
  });
}

/** Cloud control-plane operations (Azure Resource Manager): slow, so generous timeouts and heartbeats. */
export const compute = proxyActivities<
  Pick<SentryActivities, 'stopRegionCompute' | 'startRegionCompute' | 'tagRegionRoles'>
>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '1 minute',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['NonRetryableHttpError'],
  },
});

/** Alerts try hard (a lost alert is worse than a late one), but never longer than ten minutes. */
export const alerts = proxyActivities<Pick<SentryActivities, 'sendAlert'>>({
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    nonRetryableErrorTypes: ['NonRetryableHttpError'],
  },
});
