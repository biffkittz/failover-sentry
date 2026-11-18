/**
 * Payloads of the sentry's Temporal messages (signals, updates) and of the HTTP APIs between the components.
 */
import type {
  AlertRecord,
  ChaosSettings,
  DatabaseSnapshot,
  EdgeRouting,
  FailoverMode,
  FailoverOutcome,
  FailoverPhase,
  PromotionMode,
  RegionId,
  SentryConfig,
  StallDecision,
} from './domain.js';
import type { SentryCarriedState } from './carried.js';

// ---------------------------------------------------------------------------------------------------------------------
// Workflow inputs
// ---------------------------------------------------------------------------------------------------------------------

export interface SentryWorkflowInput {
  config: SentryConfig;
  /** Stable hash of `config`, so the worker can tell whether the running sentry has the current configuration. */
  configVersion: string;
  /** State carried across continue-as-new. Absent on the very first run. */
  carried?: SentryCarriedState | undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Updates (operator actions) and their results
// ---------------------------------------------------------------------------------------------------------------------

export interface ManualFailoverRequest {
  /** Defaults to the healthiest standby. */
  targetRegionId?: RegionId | undefined;
  mode: FailoverMode;
  reason: string;
  requestedBy: string;
}

export interface FailoverAccepted {
  failoverId: string;
  epoch: number;
  fromRegionId: RegionId;
  toRegionId: RegionId;
  mode: FailoverMode;
}

export interface AbortFailoverRequest {
  reason: string;
  requestedBy: string;
}

export interface AbortFailoverResult {
  failoverId: string;
  abortedDuringPhase: FailoverPhase;
}

export interface SetAutoFailoverRequest {
  enabled: boolean;
  requestedBy: string;
}

export interface SetAutoFailoverResult {
  autoFailoverEnabled: boolean;
}

export interface ResolveStallRequest {
  decision: StallDecision;
  requestedBy: string;
}

export interface ResolveStallResult {
  failoverId: string;
  decision: StallDecision;
}

export interface AcknowledgeAlertRequest {
  alertId: string;
  requestedBy: string;
}

export type AcknowledgeAlertResult = AlertRecord;

export interface RecoverRegionRequest {
  regionId: RegionId;
  requestedBy: string;
}

export interface RecoverRegionAccepted {
  recoveryId: string;
  regionId: RegionId;
}

export interface ReconfigureRequest {
  config: SentryConfig;
  configVersion: string;
}

export interface ReconfigureResult {
  configVersion: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhook: replication complete (a region's database -> console webhook gateway -> signal)
// ---------------------------------------------------------------------------------------------------------------------

export type ReplicationEventType = 'replication.promotion.completed' | 'replication.promotion.failed';

/** Body of the replication webhook, and (with `receivedAt`) the payload of the replicationComplete signal. */
export interface ReplicationWebhookEvent {
  /** Unique per event; retries of one delivery repeat it, so receivers can deduplicate. */
  eventId: string;
  type: ReplicationEventType;
  failoverId: string;
  epoch: number;
  /** The region whose database was promoted (or failed to be). */
  regionId: RegionId;
  lsn: number;
  dataLossTransactions: number;
  occurredAt: string;
  error: string | null;
}

export interface ReplicationCompleteSignalPayload extends ReplicationWebhookEvent {
  /** When the console's webhook gateway received the event. */
  receivedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Regional workload admin API (signed requests; called by the worker's activities and the console)
// ---------------------------------------------------------------------------------------------------------------------

export interface PromoteRequest {
  failoverId: string;
  epoch: number;
  mode: PromotionMode;
}

export interface PromoteResponse {
  accepted: boolean;
  promotionId: string;
  db: DatabaseSnapshot;
}

export interface DemoteRequest {
  failoverId: string | null;
  epoch: number;
  reason: string;
}

export interface DemoteResponse {
  demoted: boolean;
  db: DatabaseSnapshot;
}

/** Body of a 409 answer: the order carried an epoch lower than the node's (or the edge's). */
export interface StaleEpochError {
  error: 'stale_epoch';
  currentEpoch: number;
  message: string;
}

export type ChaosUpdate = Partial<ChaosSettings>;

export interface PowerRequest {
  /** `off` simulates stopped compute; `on` simulates a fresh boot (the in-memory database restarts as a replica). */
  state: 'on' | 'off';
}

/** The regional workload's health endpoint. */
export interface RegionalHealthResponse {
  regionId: RegionId;
  status: 'ok' | 'degraded' | 'down';
  version: string;
  startedAt: string;
  db: DatabaseSnapshot;
  chaos: ChaosSettings;
}

// ---------------------------------------------------------------------------------------------------------------------
// Edge router admin API
// ---------------------------------------------------------------------------------------------------------------------

export interface EdgeRoutingUpdate {
  mode: EdgeRouting['mode'];
  activeRegionId: RegionId | null;
  epoch: number;
  version: number;
  failoverId: string | null;
}

/** Answer of a routing write (PUT). */
export interface EdgeRoutingResponse {
  applied: boolean;
  routing: EdgeRouting;
  /** The Cloudflare data centre that answered (`local` when running locally). */
  colo: string;
}

/** Answer of a routing read (GET): what this edge location currently routes by. */
export interface EdgeRoutingObservation {
  routing: EdgeRouting | null;
  colo: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Console API
// ---------------------------------------------------------------------------------------------------------------------

export interface ConsoleUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface SentryUnavailable {
  running: false;
  workflowId: string;
  reason: string;
}

export interface FailoverRunSummary {
  id: string;
  outcome: FailoverOutcome | null;
}
