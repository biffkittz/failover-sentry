/**
 * The sentry's activities: everything that touches the outside world. Created with their dependencies (adapters)
 * injected, so tests can swap them for fakes.
 *
 * Error policy: transient failures (network, 5xx) are thrown as plain errors and retried by Temporal; failures a
 * retry can't fix are thrown as non-retryable ApplicationFailures; fencing refusals (stale epoch) are returned as
 * data, because the workflow decides what they mean.
 */
import { activityInfo, Context, sleep as activitySleep } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type {
  AlertSeverity,
  ComputeState,
  DatabaseSnapshot,
  EdgeProbeResult,
  EdgeRoutingObservation,
  ProbeResult,
  RegionConfig,
} from '@failover-sentry/contracts';
import { meetsThreshold, type Alerter } from '../adapters/alerts.js';
import type { ComputeController } from '../adapters/compute.js';
import type { EdgeAdminClient } from '../adapters/edge-admin.js';
import { NonRetryableHttpError } from '../adapters/http.js';
import type { RegionAdminClient } from '../adapters/region-admin.js';
import type {
  ComputeInput,
  ComputeResult,
  DatabaseOrderResult,
  DemoteDatabaseInput,
  ProbeEdgeInput,
  ProbeRegionInput,
  RegionInput,
  RequestPromotionInput,
  SendAlertInput,
  SendAlertResult,
  SetEdgeRoutingInput,
  SetEdgeRoutingResult,
  TagRegionsInput,
  TagRegionsResult,
  VerifyEdgeRoutingInput,
  VerifyEdgeRoutingResult,
  VerifyPrimaryInput,
} from './types.js';

export interface ActivityDependencies {
  regions: RegionAdminClient;
  edge: EdgeAdminClient;
  compute: ComputeController;
  alerter: Alerter;
  minimumAlertSeverity: AlertSeverity;
}

/** Converts adapter errors into Temporal's retry semantics. */
async function classify<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NonRetryableHttpError) {
      throw ApplicationFailure.nonRetryable(error.message, 'NonRetryableHttpError');
    }
    throw error;
  }
}

export function createActivities(deps: ActivityDependencies) {
  const region = (regionId: string): RegionConfig => deps.regions.region(regionId);

  return {
    /** Local activity: one health probe of a region. Failures are results, never errors. */
    async probeRegion(input: ProbeRegionInput): Promise<ProbeResult> {
      return deps.regions.probe(input.regionId, input.timeoutMs);
    },

    /** Local activity: one probe of the protected service through the edge. */
    async probeEdge(input: ProbeEdgeInput): Promise<EdgeProbeResult> {
      return deps.edge.probe(input.timeoutMs);
    },

    async getDatabaseStatus(input: RegionInput): Promise<DatabaseSnapshot> {
      return classify(() => deps.regions.getDatabaseStatus(input.regionId));
    },

    async demoteDatabase(input: DemoteDatabaseInput): Promise<DatabaseOrderResult> {
      return classify(() =>
        deps.regions.demote(input.regionId, {
          epoch: input.epoch,
          failoverId: input.failoverId,
          reason: input.reason,
        }),
      );
    },

    async requestDatabasePromotion(input: RequestPromotionInput): Promise<DatabaseOrderResult> {
      return classify(() =>
        deps.regions.promote(input.regionId, {
          epoch: input.epoch,
          failoverId: input.failoverId,
          mode: input.mode,
        }),
      );
    },

    /**
     * Succeeds once the region's database is primary at (at least) the given epoch. Until then it throws a
     * retryable error, so Temporal's retry policy does the polling with backoff, bounded by schedule-to-close.
     */
    async verifyDatabasePrimary(input: VerifyPrimaryInput): Promise<DatabaseSnapshot> {
      const db = await classify(() => deps.regions.getDatabaseStatus(input.regionId));
      if (db.role !== 'primary' || db.epoch < input.epoch) {
        throw ApplicationFailure.retryable(
          `${input.regionId} is ${db.role} at epoch ${db.epoch}; waiting for primary at epoch ${input.epoch}`,
          'NotPrimaryYet',
        );
      }
      return db;
    },

    async getEdgeRouting(): Promise<EdgeRoutingObservation> {
      return classify(() => deps.edge.getRouting());
    },

    async setEdgeRouting(input: SetEdgeRoutingInput): Promise<SetEdgeRoutingResult> {
      return classify(() => deps.edge.setRouting(input));
    },

    /**
     * Polls the edge until it routes to the expected region at (at least) the given epoch and version. KV is
     * eventually consistent, so this is where propagation shows. Heartbeats each attempt: a cancelled failover
     * (operator abort) reaches the activity through the heartbeat and stops the polling at once.
     */
    async verifyEdgeRouting(input: VerifyEdgeRoutingInput): Promise<VerifyEdgeRoutingResult> {
      const context = Context.current();
      const deadline = Date.now() + input.timeoutSeconds * 1000;
      const interval = input.pollIntervalMs ?? 2_000;
      let attempts = (context.info.heartbeatDetails as { attempts?: number } | undefined)?.attempts ?? 0;
      let lastSeen: string | undefined;
      for (;;) {
        attempts += 1;
        try {
          const { routing, colo } = await deps.edge.getRouting();
          if (
            routing &&
            routing.mode === 'active' &&
            routing.activeRegionId === input.expectedRegionId &&
            (routing.epoch > input.minEpoch ||
              (routing.epoch === input.minEpoch && routing.version >= input.minVersion))
          ) {
            return { observedAt: new Date().toISOString(), colo, attempts, routing };
          }
          lastSeen = routing
            ? `${routing.mode} → ${routing.activeRegionId ?? 'none'} at epoch ${routing.epoch} v${routing.version} (${colo})`
            : `no routing (${colo})`;
        } catch (error) {
          lastSeen = `error: ${(error as Error).message}`;
        }
        context.heartbeat({ attempts, lastSeen });
        if (Date.now() >= deadline) {
          throw ApplicationFailure.nonRetryable(
            `Edge did not converge on ${input.expectedRegionId} (epoch ${input.minEpoch}) within ${input.timeoutSeconds}s; last saw ${lastSeen ?? 'nothing'}`,
            'EdgePropagationTimeout',
          );
        }
        await activitySleep(interval);
      }
    },

    async stopRegionCompute(input: ComputeInput): Promise<ComputeResult> {
      return classify(async () => {
        const target = region(input.regionId);
        // Azure's long-running operations take a while; heartbeats keep the activity visibly alive meanwhile.
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat({ action: 'stop' }), 10_000);
        try {
          const detail = await deps.compute.stop(target);
          return { state: 'stopped' as ComputeState, detail };
        } finally {
          clearInterval(heartbeat);
        }
      });
    },

    async startRegionCompute(input: ComputeInput): Promise<ComputeResult> {
      return classify(async () => {
        const target = region(input.regionId);
        // Azure's long-running operations take a while; heartbeats keep the activity visibly alive meanwhile.
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat({ action: 'start' }), 10_000);
        try {
          const detail = await deps.compute.start(target);
          return { state: 'running' as ComputeState, detail };
        } finally {
          clearInterval(heartbeat);
        }
      });
    },

    /** Best effort: records each region's DR role and the epoch on its compute resource (visible in the portal). */
    async tagRegionRoles(input: TagRegionsInput): Promise<TagRegionsResult> {
      return classify(async () => {
        const tagged: string[] = [];
        const skipped: string[] = [];
        for (const { regionId, role } of input.roles) {
          const applied = await deps.compute.tag(region(regionId), {
            'dr-role': role.toLowerCase(),
            'dr-epoch': String(input.epoch),
          });
          (applied ? tagged : skipped).push(regionId);
        }
        return { tagged, skipped };
      });
    },

    async sendAlert(input: SendAlertInput): Promise<SendAlertResult> {
      if (!meetsThreshold(input.alert.severity, deps.minimumAlertSeverity)) {
        return { delivery: 'skipped', detail: `below the ${deps.minimumAlertSeverity} threshold` };
      }
      return classify(async () => {
        const detail = await deps.alerter.send(input.alert, {
          serviceName: input.serviceName,
          consoleUrl: input.consoleUrl,
        });
        return { delivery: 'sent' as const, detail: `${detail} (attempt ${activityInfo().attempt})` };
      });
    },
  };
}

export type SentryActivities = ReturnType<typeof createActivities>;
