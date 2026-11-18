/**
 * The sentry's decisions, as pure functions of what it knows. Workflow code calls them; keeping them pure makes
 * them deterministic on replay and testable without Temporal.
 */
import type {
  ComputeState,
  EdgeRouting,
  FailoverMode,
  FailoverPolicy,
  HealthPolicy,
  RegionHealthSnapshot,
  RegionId,
} from '@failover-sentry/contracts';

export interface RegionFacts {
  id: RegionId;
  displayName: string;
  /** Position in the configuration; the tie-breaker when two standbys are equally good. */
  order: number;
  health: RegionHealthSnapshot | null;
  compute: ComputeState;
}

export interface DecisionContext {
  nowMs: number;
  activeRegionId: RegionId;
  regions: readonly RegionFacts[];
  healthPolicy: HealthPolicy;
  failoverPolicy: FailoverPolicy;
}

/**
 * Monitors report on every change and at least every `reportEveryProbes` probes, so a snapshot older than that
 * (with margin) means the monitor itself is not reporting, and its verdict can't be trusted.
 */
export function stalenessLimitMs(policy: HealthPolicy): number {
  return Math.round(policy.probeIntervalSeconds * 1000 * (policy.reportEveryProbes + 2) * 1.5);
}

export function isFresh(
  snapshot: RegionHealthSnapshot,
  context: Pick<DecisionContext, 'nowMs' | 'healthPolicy'>,
): boolean {
  return context.nowMs - Date.parse(snapshot.observedAt) <= stalenessLimitMs(context.healthPolicy);
}

// ---------------------------------------------------------------------------------------------------------------------
// Failover targets
// ---------------------------------------------------------------------------------------------------------------------

export type TargetChoice = { regionId: RegionId; reason: string } | { regionId: null; reason: string };

/**
 * The best standby to fail over to: HEALTHY (or DEGRADED when allowed), freshly observed, compute running, its
 * database a replica. Ties go to the smallest replication lag, then the most data, then configuration order.
 */
export function chooseFailoverTarget(
  context: DecisionContext,
  options: { allowDegraded?: boolean; exclude?: readonly RegionId[] } = {},
): TargetChoice {
  const rejected: string[] = [];
  const candidates = context.regions.filter((region) => {
    if (region.id === context.activeRegionId || options.exclude?.includes(region.id)) {
      return false;
    }
    const why = disqualification(region, context, options.allowDegraded ?? false);
    if (why) {
      rejected.push(`${region.id}: ${why}`);
      return false;
    }
    return true;
  });
  if (candidates.length === 0) {
    return {
      regionId: null,
      reason:
        rejected.length > 0
          ? `no eligible standby (${rejected.join('; ')})`
          : 'no standby regions configured',
    };
  }
  const sorted = [...candidates].sort((a, b) => {
    const lagA = a.health?.lastProbe?.db?.lagSeconds ?? Number.POSITIVE_INFINITY;
    const lagB = b.health?.lastProbe?.db?.lagSeconds ?? Number.POSITIVE_INFINITY;
    if (lagA !== lagB) {
      return lagA - lagB;
    }
    const lsnA = a.health?.lastProbe?.db?.appliedLsn ?? 0;
    const lsnB = b.health?.lastProbe?.db?.appliedLsn ?? 0;
    if (lsnA !== lsnB) {
      return lsnB - lsnA;
    }
    return a.order - b.order;
  });
  const best = sorted[0];
  if (!best) {
    return { regionId: null, reason: 'no standby regions configured' };
  }
  const lag = best.health?.lastProbe?.db?.lagSeconds;
  return {
    regionId: best.id,
    reason: `${best.displayName} is ${best.health?.status ?? 'UNKNOWN'}${lag === null || lag === undefined ? '' : ` with ${lag}s replication lag`}`,
  };
}

function disqualification(
  region: RegionFacts,
  context: DecisionContext,
  allowDegraded: boolean,
): string | null {
  if (region.compute === 'stopped' || region.compute === 'starting') {
    return `compute ${region.compute}`;
  }
  const health = region.health;
  if (!health) {
    return 'not observed yet';
  }
  if (!isFresh(health, context)) {
    return 'monitor not reporting';
  }
  const acceptable = health.status === 'HEALTHY' || (allowDegraded && health.status === 'DEGRADED');
  if (!acceptable) {
    return health.status;
  }
  const db = health.lastProbe?.db;
  if (!db) {
    return 'database state unknown';
  }
  if (db.role !== 'replica') {
    return `database is ${db.role}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Automatic failover
// ---------------------------------------------------------------------------------------------------------------------

export type AutomaticDecision =
  | { kind: 'none' }
  | { kind: 'cooldown'; untilMs: number; reason: string }
  | { kind: 'no-target'; reason: string }
  | { kind: 'failover'; targetRegionId: RegionId; mode: FailoverMode; reason: string };

/**
 * Fails over only when the primary is UNHEALTHY *and* a standby is HEALTHY. When the sentry can see no healthy
 * region at all, the likelier explanation is its own connectivity, so it does nothing (the third-site "witness"
 * property). The mode starts as forced; the failover's precheck downgrades it to planned when the old primary's
 * database still answers.
 */
export function decideAutomaticFailover(
  context: DecisionContext & { lastAutomaticFailoverAtMs: number | null },
): AutomaticDecision {
  const active = context.regions.find((region) => region.id === context.activeRegionId);
  const health = active?.health;
  if (!active || !health || health.status !== 'UNHEALTHY' || !isFresh(health, context)) {
    return { kind: 'none' };
  }
  const cooldownMs = context.failoverPolicy.cooldownSeconds * 1000;
  if (
    context.lastAutomaticFailoverAtMs !== null &&
    context.nowMs - context.lastAutomaticFailoverAtMs < cooldownMs
  ) {
    const untilMs = context.lastAutomaticFailoverAtMs + cooldownMs;
    return {
      kind: 'cooldown',
      untilMs,
      reason: `automatic failover is cooling down until ${new Date(untilMs).toISOString()}`,
    };
  }
  const target = chooseFailoverTarget(context);
  if (target.regionId === null) {
    return { kind: 'no-target', reason: `${active.displayName} is UNHEALTHY, but ${target.reason}` };
  }
  const lastError =
    health.lastProbe?.error ??
    (health.lastProbe?.httpStatus ? `HTTP ${health.lastProbe.httpStatus}` : 'no answer');
  return {
    kind: 'failover',
    targetRegionId: target.regionId,
    mode: 'forced',
    reason: `${active.displayName} is UNHEALTHY: ${health.consecutiveFailures} consecutive failed probes (last: ${lastError}); ${target.reason}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reconciliation (normal operations keep reality in line with the sentry's intent)
// ---------------------------------------------------------------------------------------------------------------------

export type ReconcileAction =
  /** A region other than the active one claims to be primary: the stale side of a split brain. */
  | { kind: 'fence-stale-primary'; regionId: RegionId; reportedEpoch: number }
  /** No database is primary (first start, or the active region restarted): re-promote the active region's. */
  | { kind: 'restore-active-primary'; regionId: RegionId; epochFloor: number }
  /** The active region lost its data but a standby holds newer data: move to the standby instead. */
  | { kind: 'failover-to-freshest'; regionId: RegionId; reason: string }
  /** The edge doesn't route to the active region at the current epoch. */
  | { kind: 'sync-edge'; regionId: RegionId };

export function planReconciliation(
  context: DecisionContext & { epoch: number; edge: EdgeRouting | null },
): ReconcileAction | null {
  const usable = (
    region: RegionFacts | undefined,
  ): region is RegionFacts & { health: RegionHealthSnapshot } =>
    Boolean(
      region?.health &&
      isFresh(region.health, context) &&
      region.health.lastProbe?.ok &&
      region.health.lastProbe.db,
    );

  const active = context.regions.find((region) => region.id === context.activeRegionId);
  const others = context.regions.filter((region) => region.id !== context.activeRegionId);

  for (const region of others) {
    const db = usable(region) ? region.health.lastProbe?.db : null;
    if (db?.role === 'primary') {
      return { kind: 'fence-stale-primary', regionId: region.id, reportedEpoch: db.epoch };
    }
  }

  if (!usable(active)) {
    return null;
  }
  const activeDb = active.health.lastProbe?.db;
  if (!activeDb) {
    return null;
  }
  const promoting =
    activeDb.promotion?.status === 'catching-up' || activeDb.promotion?.status === 'switching';
  if (activeDb.role === 'replica' && !promoting) {
    const contenders = [active, ...others.filter(usable)];
    const freshest = contenders.reduce((best, region) =>
      (region.health?.lastProbe?.db?.appliedLsn ?? 0) > (best.health?.lastProbe?.db?.appliedLsn ?? 0)
        ? region
        : best,
    );
    const epochFloor = Math.max(
      context.epoch,
      ...contenders.map((region) => region.health?.lastProbe?.db?.epoch ?? 0),
    );
    if (freshest.id !== active.id) {
      const freshestLsn = freshest.health?.lastProbe?.db?.appliedLsn ?? 0;
      return {
        kind: 'failover-to-freshest',
        regionId: freshest.id,
        reason: `${active.displayName}'s database came back empty (log position ${activeDb.appliedLsn}) while ${freshest.displayName} holds position ${freshestLsn}`,
      };
    }
    return { kind: 'restore-active-primary', regionId: active.id, epochFloor };
  }

  const edge = context.edge;
  if (
    activeDb.role === 'primary' &&
    (!edge || edge.mode !== 'active' || edge.activeRegionId !== active.id || edge.epoch < context.epoch)
  ) {
    return { kind: 'sync-edge', regionId: active.id };
  }
  return null;
}
