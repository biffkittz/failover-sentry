/**
 * The sentry's state: everything it knows and has decided, kept small (bounded collections) because it is replayed
 * from history and carried across continue-as-new. All times are workflow time, so this is deterministic.
 */
import {
  FAILOVER_STEPS,
  LIMITS,
  type AlertKind,
  type AlertRecord,
  type AlertSeverity,
  type ComputeState,
  type EdgeRouting,
  type FailoverRun,
  type RegionHealthSnapshot,
  type RegionId,
  type RegionRecovery,
  type RegionView,
  type SentryCarriedState,
  type SentryConfig,
  type SentryMode,
  type SentryStateView,
  type SentryWorkflowInput,
  type TimelineEvent,
} from '@failover-sentry/contracts';
import { workflowInfo } from '@temporalio/workflow';
import type { RegionFacts } from '../../domain/decisions.js';

export interface FailoverTrigger {
  failoverId: string;
  kind: FailoverRun['trigger'];
  targetRegionId: RegionId;
  mode: FailoverRun['mode'];
  reason: string;
  requestedBy: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class SentryState {
  config: SentryConfig;
  configVersion: string;
  readonly startedAt: string;
  readonly runStartedAt: string;
  readonly continuedAsNewCount: number;
  mode: SentryMode;
  epoch: number;
  activeRegionId: RegionId;
  autoFailoverEnabled: boolean;
  autoFailoverSuspendedReason: string | null;
  lastAutomaticFailoverAt: string | null;
  edge: EdgeRouting | null;
  readonly regionHealth = new Map<RegionId, RegionHealthSnapshot>();
  readonly regionCompute = new Map<RegionId, ComputeState>();
  readonly recoveries = new Map<RegionId, RegionRecovery>();
  currentFailover: FailoverRun | null = null;
  recentFailovers: FailoverRun[];
  alerts: AlertRecord[];
  timeline: TimelineEvent[];
  processedEventIds: string[];
  /** Monotonic counter behind generated IDs and edge write versions. */
  sequence: number;
  /** True when this run carries state from a previous run (continue-as-new). */
  readonly resumed: boolean;

  constructor(input: SentryWorkflowInput) {
    const carried = input.carried;
    this.config = input.config;
    this.configVersion = input.configVersion;
    this.runStartedAt = nowIso();
    this.resumed = Boolean(carried);
    this.startedAt = carried?.startedAt ?? this.runStartedAt;
    this.continuedAsNewCount = carried ? carried.continuedAsNewCount + 1 : 0;
    this.mode = carried?.mode === 'MANUAL_INTERVENTION_REQUIRED' ? 'MANUAL_INTERVENTION_REQUIRED' : 'NORMAL';
    this.epoch = carried?.epoch ?? 0;
    this.activeRegionId = carried?.activeRegionId ?? input.config.initialPrimaryRegionId;
    this.autoFailoverEnabled = carried?.autoFailoverEnabled ?? input.config.failover.autoFailoverEnabled;
    this.autoFailoverSuspendedReason = carried?.autoFailoverSuspendedReason ?? null;
    this.lastAutomaticFailoverAt = carried?.lastAutomaticFailoverAt ?? null;
    this.edge = carried?.edge ?? null;
    this.recentFailovers = carried?.recentFailovers ?? [];
    this.alerts = carried?.alerts ?? [];
    this.timeline = carried?.timeline ?? [];
    this.processedEventIds = carried?.processedEventIds ?? [];
    this.sequence = carried?.sequence ?? 0;
    for (const [regionId, snapshot] of Object.entries(carried?.regionHealth ?? {})) {
      this.regionHealth.set(regionId, snapshot);
    }
    for (const region of input.config.regions) {
      this.regionCompute.set(region.id, carried?.regionCompute[region.id] ?? 'unknown');
    }
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  /** The next edge write version (monotonic for the life of the sentry, across continue-as-new). */
  nextVersion(): number {
    this.sequence += 1;
    return this.sequence;
  }

  region(regionId: RegionId) {
    return this.config.regions.find((region) => region.id === regionId);
  }

  displayName(regionId: RegionId): string {
    return this.region(regionId)?.displayName ?? regionId;
  }

  regionFacts(): RegionFacts[] {
    return this.config.regions.map((region, order) => ({
      id: region.id,
      displayName: region.displayName,
      order,
      health: this.regionHealth.get(region.id) ?? null,
      compute: this.regionCompute.get(region.id) ?? 'unknown',
    }));
  }

  record(
    kind: string,
    message: string,
    options: { severity?: AlertSeverity; failoverId?: string | null; regionId?: RegionId | null } = {},
  ): TimelineEvent {
    const event: TimelineEvent = {
      id: this.nextId('ev'),
      at: nowIso(),
      kind,
      message,
      severity: options.severity ?? 'info',
      failoverId: options.failoverId ?? null,
      regionId: options.regionId ?? null,
    };
    this.timeline.unshift(event);
    if (this.timeline.length > LIMITS.timeline) {
      this.timeline.length = LIMITS.timeline;
    }
    return event;
  }

  addAlert(
    kind: AlertKind,
    severity: AlertSeverity,
    title: string,
    message: string,
    options: { failoverId?: string | null; regionId?: RegionId | null } = {},
  ): AlertRecord {
    const alert: AlertRecord = {
      id: this.nextId('al'),
      kind,
      severity,
      title,
      message,
      at: nowIso(),
      failoverId: options.failoverId ?? null,
      regionId: options.regionId ?? null,
      delivery: 'pending',
      deliveryDetail: null,
      acknowledgedBy: null,
      acknowledgedAt: null,
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > LIMITS.alerts) {
      this.alerts.length = LIMITS.alerts;
    }
    this.record(kind, `${title}: ${message}`, { severity, ...options });
    return alert;
  }

  rememberEvent(eventId: string): boolean {
    if (this.processedEventIds.includes(eventId)) {
      return false;
    }
    this.processedEventIds.push(eventId);
    if (this.processedEventIds.length > LIMITS.processedEventIds) {
      this.processedEventIds.splice(0, this.processedEventIds.length - LIMITS.processedEventIds);
    }
    return true;
  }

  newFailoverRun(trigger: FailoverTrigger, fromRegionId: RegionId, epoch: number): FailoverRun {
    return {
      id: trigger.failoverId,
      epoch,
      trigger: trigger.kind,
      mode: trigger.mode,
      reason: trigger.reason,
      requestedBy: trigger.requestedBy,
      fromRegionId,
      toRegionId: trigger.targetRegionId,
      startedAt: nowIso(),
      endedAt: null,
      phase: 'PRECHECK',
      outcome: null,
      steps: FAILOVER_STEPS.map((name) => ({
        name,
        status: 'PENDING',
        startedAt: null,
        endedAt: null,
        detail: null,
      })),
      replication: null,
      stall: null,
      stabilization: null,
      compensations: [],
      error: null,
      abortRequestedBy: null,
    };
  }

  archive(run: FailoverRun): void {
    this.recentFailovers.unshift(run);
    if (this.recentFailovers.length > LIMITS.recentFailovers) {
      this.recentFailovers.length = LIMITS.recentFailovers;
    }
  }

  regionViews(): RegionView[] {
    return this.config.regions.map((region) => ({
      config: region,
      role: region.id === this.activeRegionId ? 'PRIMARY' : 'STANDBY',
      health: this.regionHealth.get(region.id) ?? null,
      compute: this.regionCompute.get(region.id) ?? 'unknown',
      recovery: this.recoveries.get(region.id) ?? null,
    }));
  }

  view(cooldownUntil: string | null): SentryStateView {
    const info = workflowInfo();
    return {
      workflowId: info.workflowId,
      runId: info.runId,
      serviceName: this.config.serviceName,
      configVersion: this.configVersion,
      mode: this.mode,
      epoch: this.epoch,
      activeRegionId: this.activeRegionId,
      autoFailoverEnabled: this.autoFailoverEnabled,
      autoFailoverSuspendedReason: this.autoFailoverSuspendedReason,
      cooldownUntil,
      regions: this.regionViews(),
      edge: this.edge,
      currentFailover: this.currentFailover,
      recentFailovers: this.recentFailovers,
      alerts: this.alerts,
      timeline: this.timeline,
      health: this.config.health,
      failoverPolicy: this.config.failover,
      edgePublicUrl: this.config.edgePublicUrl,
      startedAt: this.startedAt,
      runStartedAt: this.runStartedAt,
      continuedAsNewCount: this.continuedAsNewCount,
      historyLength: info.historyLength,
      updatedAt: nowIso(),
    };
  }

  carry(): SentryCarriedState {
    return {
      startedAt: this.startedAt,
      continuedAsNewCount: this.continuedAsNewCount,
      mode: this.mode,
      epoch: this.epoch,
      activeRegionId: this.activeRegionId,
      autoFailoverEnabled: this.autoFailoverEnabled,
      autoFailoverSuspendedReason: this.autoFailoverSuspendedReason,
      lastAutomaticFailoverAt: this.lastAutomaticFailoverAt,
      edge: this.edge,
      regionHealth: Object.fromEntries(this.regionHealth),
      regionCompute: Object.fromEntries(this.regionCompute),
      recentFailovers: this.recentFailovers,
      alerts: this.alerts,
      timeline: this.timeline,
      processedEventIds: this.processedEventIds,
      sequence: this.sequence,
    };
  }
}
