/**
 * Inputs and outputs of the sentry's activities. Workflows import these as types only (activities run outside the
 * workflow sandbox, reached through proxies).
 *
 * Activities take region IDs, never URLs: the worker resolves them from its own configuration, so a workflow input
 * can't point the worker at an arbitrary host.
 */
import type {
  AlertRecord,
  ComputeState,
  DatabaseSnapshot,
  EdgeRouting,
  PromotionMode,
  RegionId,
  RegionRole,
} from '@failover-sentry/contracts';

export interface ProbeRegionInput {
  regionId: RegionId;
  timeoutMs: number;
}

export interface ProbeEdgeInput {
  timeoutMs: number;
}

export interface RegionInput {
  regionId: RegionId;
}

/** Orders to a database answer with its new state, or with the epoch that made it refuse (fencing). */
export type DatabaseOrderResult =
  | { outcome: 'ok'; db: DatabaseSnapshot; promotionId: string | null }
  | { outcome: 'stale-epoch'; currentEpoch: number };

export interface DemoteDatabaseInput {
  regionId: RegionId;
  epoch: number;
  failoverId: string | null;
  reason: string;
}

export interface RequestPromotionInput {
  regionId: RegionId;
  epoch: number;
  failoverId: string;
  mode: PromotionMode;
}

export interface VerifyPrimaryInput {
  regionId: RegionId;
  epoch: number;
}

export interface SetEdgeRoutingInput {
  mode: EdgeRouting['mode'];
  activeRegionId: RegionId | null;
  epoch: number;
  version: number;
  failoverId: string | null;
}

export type SetEdgeRoutingResult =
  | { outcome: 'applied' | 'unchanged'; routing: EdgeRouting; colo: string }
  | { outcome: 'stale'; routing: EdgeRouting | null };

export interface VerifyEdgeRoutingInput {
  expectedRegionId: RegionId;
  minEpoch: number;
  minVersion: number;
  timeoutSeconds: number;
  pollIntervalMs?: number;
}

export interface VerifyEdgeRoutingResult {
  observedAt: string;
  colo: string;
  attempts: number;
  routing: EdgeRouting;
}

export interface ComputeInput {
  regionId: RegionId;
  reason: string;
}

export interface ComputeResult {
  state: ComputeState;
  detail: string;
}

export interface TagRegionsInput {
  epoch: number;
  roles: Array<{ regionId: RegionId; role: RegionRole }>;
}

export interface TagRegionsResult {
  tagged: RegionId[];
  skipped: RegionId[];
}

export interface SendAlertInput {
  alert: AlertRecord;
  serviceName: string;
  consoleUrl: string;
}

export interface SendAlertResult {
  delivery: 'sent' | 'skipped';
  detail: string;
}
