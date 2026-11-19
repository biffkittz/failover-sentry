/**
 * Domain model of the Failover Sentry, shared by the Temporal workflows, the activities, the console's server and
 * its Vue app. Everything here is plain data (JSON-serialisable) because it crosses Temporal payloads, HTTP and
 * Server-Sent Events.
 *
 * Time values are ISO-8601 strings. Inside workflows they come from workflow time (deterministic), elsewhere from the
 * wall clock.
 */

/** Identifier of a monitored region, e.g. `eastus2`. Lower-case letters, digits and hyphens. */
export type RegionId = string;

/** The role the sentry has assigned to a region. Exactly one region is PRIMARY at any epoch. */
export type RegionRole = 'PRIMARY' | 'STANDBY';

/** The sentry's verdict about a region, computed from a rolling window of probes. */
export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

/** What the region's own (simulated) database says about itself. */
export type DatabaseRole = 'primary' | 'replica';

/** Planned failovers synchronise first (no data loss); forced failovers promote immediately (possible data loss). */
export type FailoverMode = 'planned' | 'forced';

/** `restore` re-promotes a node that was primary moments ago (compensation, reconciliation); it skips the sync. */
export type PromotionMode = FailoverMode | 'restore';

export type FailoverTriggerKind = 'AUTOMATIC' | 'MANUAL';

/** Whether the region's compute is running, as far as the sentry knows (it stops a region to fence it). */
export type ComputeState = 'running' | 'stopped' | 'starting' | 'unknown';

// ---------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------

export interface RegionConfig {
  id: RegionId;
  displayName: string;
  /** Where the region runs. The workflows treat every provider alike; only the compute adapter differs. */
  provider: 'azure' | 'local';
  /** Base URL of the region's workload, without a trailing slash. Health is `GET {baseUrl}/healthz`. */
  baseUrl: string;
  /** Azure resource ID of the region's Container App (provider `azure`): the sentry stops it to fence it. */
  azureResourceId?: string | undefined;
}

export interface HealthPolicy {
  /** Time between two probes of one region. */
  probeIntervalSeconds: number;
  /** A probe slower than this fails. */
  probeTimeoutMs: number;
  /** Consecutive failed probes that make a region UNHEALTHY. */
  failureThreshold: number;
  /** Probes slower than this count as slow; two in a row make a region DEGRADED. */
  degradedLatencyMs: number;
  /** Probes kept in the rolling window. */
  windowSize: number;
  /** A monitor reports to the sentry at least every this many probes, even when nothing changed. */
  reportEveryProbes: number;
}

export interface FailoverPolicy {
  /** Fail over automatically when the primary becomes UNHEALTHY and a standby is HEALTHY. */
  autoFailoverEnabled: boolean;
  /** Minimum time between two automatic failovers, so a flapping region can't ping-pong traffic. */
  cooldownSeconds: number;
  /** Durable timeout for the replication-complete webhook before the sentry checks directly and alerts. */
  replicationTimeoutSeconds: number;
  /** After a stall alert, how long to wait for the webhook or an operator before reverting. */
  stallEscalationSeconds: number;
  /** Longest wait for the edge to serve the new routing. */
  edgePropagationTimeoutSeconds: number;
  /** How long the new primary is watched through the edge before the failover counts as complete. */
  stabilizationSeconds: number;
  stabilizationProbeIntervalSeconds: number;
  /** Consecutive failed probes through the edge during stabilisation that make the sentry revert. */
  stabilizationFailureThreshold: number;
  /** Stop (fence) the old primary's compute through the cloud API during forced failovers. */
  fenceComputeOnForcedFailover: boolean;
}

export interface SentryConfig {
  /** Name of the protected service; part of the workflow ID. */
  serviceName: string;
  /** Public URL of the protected service at the edge, e.g. `https://dr.biffkittz.com`. */
  edgePublicUrl: string;
  /** Console URL used in alert links, e.g. `https://sentry.biffkittz.com`. */
  consoleUrl: string;
  regions: RegionConfig[];
  /** The region that starts as primary when the sentry runs for the first time. */
  initialPrimaryRegionId: RegionId;
  health: HealthPolicy;
  failover: FailoverPolicy;
}

// ---------------------------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------------------------

/** An in-flight promotion on a (simulated) database node. */
export interface PromotionSnapshot {
  promotionId: string;
  failoverId: string;
  epoch: number;
  mode: PromotionMode;
  status: 'catching-up' | 'switching' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

/** The database state a region reports in its health endpoint. */
export interface DatabaseSnapshot {
  role: DatabaseRole;
  /** The fencing token this node last accepted. A node never accepts an order carrying a lower one. */
  epoch: number;
  /** Primary: last written log position. Replica: last position received from the primary. */
  lsn: number;
  /** Replica: last applied position. Primary: equals `lsn`. */
  appliedLsn: number;
  /** Replica: seconds since it was last caught up with the primary; null when unknown or primary. */
  lagSeconds: number | null;
  /**
   * Replica: seconds since it last heard from a primary (null when it never has, or is primary). A planned
   * failover needs this to be small: the target must be able to reach the old primary to catch up. Absent from
   * regions running versions that predate it.
   */
  primaryContactAgeSeconds?: number | null;
  promotion: PromotionSnapshot | null;
}

/** Chaos settings of a region (the console's chaos panel sets them). */
export interface ChaosSettings {
  /** `down` makes every public endpoint answer 503; `degraded` makes health report degraded. */
  health: 'healthy' | 'degraded' | 'down';
  /** Added to every response. */
  latencyMs: number;
  /** Fraction of requests (0..1) that fail with 500. */
  errorRate: number;
  /**
   * How promotions on this node behave: `slow` triples the sync time, `stalled` never finishes, `drop-webhook`
   * finishes without notifying the sentry, `fail` gives up.
   */
  replication: 'normal' | 'slow' | 'stalled' | 'drop-webhook' | 'fail';
}

export interface ProbeResult {
  regionId: RegionId;
  /** Wall-clock time the probe started (activity time). */
  at: string;
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
  /** What the region said about itself. */
  reportedStatus: 'ok' | 'degraded' | 'down' | null;
  version: string | null;
  db: DatabaseSnapshot | null;
  chaos: ChaosSettings | null;
}

/** A probe of the protected service through the edge: who served it, and at which epoch. */
export interface EdgeProbeResult extends ProbeResult {
  servedBy: RegionId | null;
  epoch: number | null;
}

/** A monitor's assessment of one region at one point in time. */
export interface RegionHealthSnapshot {
  regionId: RegionId;
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSlow: number;
  /** Successful probes in the window, 0..1. */
  windowSuccessRate: number;
  /** Median latency of the successful probes in the window. */
  medianLatencyMs: number | null;
  probesInWindow: number;
  lastProbe: ProbeResult | null;
  /** When the monitor evaluated this (workflow time). */
  observedAt: string;
  /** Identifies one monitor execution chain (its first run ID), so restarts don't look like reordering. */
  monitorInstanceId: string;
  /** Increases with every report of one monitor instance. */
  sequence: number;
}

export type HealthReportReason = 'STATUS_CHANGED' | 'DATABASE_CHANGED' | 'PERIODIC' | 'FIRST_PROBE';

/** What a monitor child workflow signals to the sentry. */
export interface RegionHealthReport {
  reason: HealthReportReason;
  snapshot: RegionHealthSnapshot;
}

// ---------------------------------------------------------------------------------------------------------------------
// Edge routing
// ---------------------------------------------------------------------------------------------------------------------

export interface EdgeRouting {
  /** `maintenance` serves a holding page while roles switch. */
  mode: 'active' | 'maintenance';
  activeRegionId: RegionId | null;
  /** Fencing token: the edge refuses writes that carry a lower epoch than the one it holds. */
  epoch: number;
  /**
   * The sentry's monotonic write counter. Together with the epoch it orders every write, so a delayed retry of an
   * old write (a "zombie" activity attempt) can't roll the routing back within one epoch.
   */
  version: number;
  failoverId: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Failovers
// ---------------------------------------------------------------------------------------------------------------------

export const FAILOVER_STEPS = [
  'PRECHECK',
  'DRAIN_EDGE',
  'FENCE_OLD_PRIMARY',
  'PROMOTE_DATABASE',
  'AWAIT_REPLICATION',
  'VERIFY_PROMOTION',
  'SWITCH_EDGE',
  'AWAIT_EDGE_PROPAGATION',
  'STABILIZATION',
  'TAG_RESOURCES',
] as const;

export type FailoverStepName = (typeof FAILOVER_STEPS)[number];

export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'WARNING' | 'FAILED' | 'SKIPPED' | 'CANCELLED';

export interface FailoverStep {
  name: FailoverStepName;
  status: StepStatus;
  startedAt: string | null;
  endedAt: string | null;
  detail: string | null;
}

export type FailoverPhase = FailoverStepName | 'AWAITING_OPERATOR' | 'COMPENSATING' | 'DONE';

/**
 * - SUCCEEDED: traffic and the primary database moved to the target.
 * - REFUSED: the precheck refused the failover before anything changed (the target failed its live check, say).
 * - REVERTED: something went wrong (or anomalies appeared) and the sentry moved everything back.
 * - ABORTED: an operator aborted and the sentry moved everything back.
 * - KEPT_TARGET: reverting was impossible (the old primary is down), so the sentry kept the target and alerted.
 * - MANUAL_INTERVENTION: neither side could serve; the edge shows the maintenance page and humans must step in.
 */
export type FailoverOutcome =
  'SUCCEEDED' | 'REFUSED' | 'REVERTED' | 'ABORTED' | 'KEPT_TARGET' | 'MANUAL_INTERVENTION';

export interface CompensationRecord {
  action: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  at: string;
  detail: string | null;
}

/** How the sentry learned that the target finished replicating and became primary. */
export interface ReplicationConfirmation {
  source: 'webhook' | 'direct-check' | 'operator';
  status: 'completed' | 'failed';
  receivedAt: string;
  eventId: string | null;
  lsn: number | null;
  dataLossTransactions: number | null;
  error: string | null;
}

export interface StallState {
  since: string;
  /** The operator's decision, once there is one. */
  decision: StallDecision | null;
  decidedBy: string | null;
}

export type StallDecision = 'keep-waiting' | 'retry-forced' | 'abort';

export interface StabilizationProgress {
  probes: number;
  consecutiveFailures: number;
  lastProbe: EdgeProbeResult | null;
  endsAt: string;
}

export interface FailoverRun {
  id: string;
  /** The fencing token the failover writes with. */
  epoch: number;
  trigger: FailoverTriggerKind;
  mode: FailoverMode;
  reason: string;
  requestedBy: string | null;
  fromRegionId: RegionId;
  toRegionId: RegionId;
  startedAt: string;
  endedAt: string | null;
  phase: FailoverPhase;
  outcome: FailoverOutcome | null;
  steps: FailoverStep[];
  replication: ReplicationConfirmation | null;
  stall: StallState | null;
  stabilization: StabilizationProgress | null;
  compensations: CompensationRecord[];
  error: string | null;
  abortRequestedBy: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Alerts and timeline
// ---------------------------------------------------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertKind =
  | 'FAILOVER_STARTED'
  | 'FAILOVER_COMPLETED'
  | 'FAILOVER_REFUSED'
  | 'FAILOVER_REVERTED'
  | 'FAILOVER_ABORTED'
  | 'REPLICATION_STALLED'
  | 'REPLICATION_WEBHOOK_MISSING'
  | 'MANUAL_INTERVENTION_REQUIRED'
  | 'SPLIT_BRAIN_FENCED'
  | 'NO_FAILOVER_TARGET'
  | 'REGION_FENCED'
  | 'REGION_RECOVERED'
  | 'RECOVERY_FAILED';

export interface AlertRecord {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  message: string;
  at: string;
  failoverId: string | null;
  regionId: RegionId | null;
  delivery: 'pending' | 'sent' | 'failed' | 'skipped';
  deliveryDetail: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  message: string;
  severity: AlertSeverity;
  failoverId: string | null;
  regionId: RegionId | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The sentry's state, as its query returns it
// ---------------------------------------------------------------------------------------------------------------------

export type SentryMode = 'NORMAL' | 'FAILING_OVER' | 'MANUAL_INTERVENTION_REQUIRED';

export interface RegionView {
  config: RegionConfig;
  role: RegionRole;
  health: RegionHealthSnapshot | null;
  compute: ComputeState;
  /** Set while a recovery (start compute, wait for health, rejoin as replica) runs. */
  recovery: RegionRecovery | null;
}

export interface RegionRecovery {
  id: string;
  requestedBy: string;
  startedAt: string;
  phase: 'STARTING_COMPUTE' | 'AWAITING_HEALTH' | 'DONE' | 'FAILED';
  detail: string | null;
}

export interface SentryStateView {
  workflowId: string;
  runId: string;
  serviceName: string;
  configVersion: string;
  mode: SentryMode;
  /** The sentry's current fencing token. */
  epoch: number;
  activeRegionId: RegionId;
  autoFailoverEnabled: boolean;
  /** Why automatic failover is off, when the sentry turned it off itself. */
  autoFailoverSuspendedReason: string | null;
  cooldownUntil: string | null;
  regions: RegionView[];
  /** The routing the sentry last wrote to the edge. */
  edge: EdgeRouting | null;
  currentFailover: FailoverRun | null;
  recentFailovers: FailoverRun[];
  alerts: AlertRecord[];
  timeline: TimelineEvent[];
  health: SentryConfig['health'];
  failoverPolicy: SentryConfig['failover'];
  edgePublicUrl: string;
  startedAt: string;
  runStartedAt: string;
  continuedAsNewCount: number;
  historyLength: number;
  updatedAt: string;
}

/** What a region monitor child workflow returns from its query. */
export interface MonitorStateView {
  regionId: RegionId;
  role: RegionRole;
  status: HealthStatus;
  probes: ProbeResult[];
  consecutiveFailures: number;
  startedAt: string;
  iterations: number;
  continuedAsNewCount: number;
}
