/**
 * The sentry's decisions, as pure functions of what it knows. Workflow code calls them; keeping them pure makes
 * them deterministic on replay and testable without Temporal.
 *
 * Where this sits in the system
 * -----------------------------
 *
 *   regional app /healthz ──probe──▶ monitor child (monitor-region.ts)
 *                                     │ evaluateHealth() (health.ts): HEALTHY / DEGRADED / UNHEALTHY
 *                                     ▼ regionHealthReport signal, on change and periodically
 *   sentry workflow (sentry.ts) ── stores the snapshot ── SentryState.decisionContext() (state.ts) builds a
 *                                                          DecisionContext: one RegionFacts per region
 *                                     │
 *          ┌──────────────────────────┼─────────────────────────────┐
 *          ▼                          ▼                             ▼
 *   decideAutomaticFailover()   planReconciliation()         chooseFailoverTarget()
 *   after every health report   in the reconciler's loop     for a manual failover with no target
 *   (evaluateAutomaticFailover) (reconciliationPlan)         (validators.ts resolveManualTarget)
 *          │                          │                             │
 *          ▼                          ▼                             ▼
 *   a pending automatic         one corrective action        the region the operator's
 *   failover (runFailover)      (reconcile)                  failover goes to
 *
 * The workflow does all the I/O (activities, timers, signals); this file only answers questions about a snapshot of
 * facts. Nothing here talks to a region, reads a clock or keeps state: `nowMs` arrives in the context (workflow time,
 * the same on every replay), and a decision is fully determined by its arguments. That is why the workflow can
 * re-evaluate these functions as often as it likes (planReconciliation runs inside a condition that Temporal
 * re-checks after every event) and why test/domain/decisions.test.ts can cover them without a Temporal server.
 *
 * The facts are second-hand and may be stale: each region's health is the monitor's last report, not a live probe.
 * So every decision first asks whether its evidence is fresh (isFresh), and the failover itself re-probes everything
 * live in its precheck (failover.ts) before it changes anything. A decision here is a reason to start; the precheck
 * is the confirmation.
 *
 * Safety principles these functions encode:
 * - Fail over only on positive evidence: the primary freshly reported UNHEALTHY *and* a usable standby exists.
 * - Silence is not evidence: a monitor that stopped reporting disqualifies its region; it doesn't condemn it.
 * - Never route to, or promote, a region whose database isn't in the expected role.
 * - Two primaries are the worst state, so fencing a stale primary comes before every other correction.
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

/**
 * What the sentry knows about one region, as SentryState.regionFacts() assembles it from the region's configuration,
 * its monitor's last health report and its compute state.
 */
export interface RegionFacts {
  id: RegionId;
  displayName: string;
  /** Position in the configuration; the tie-breaker when two standbys are equally good. */
  order: number;
  /**
   * The monitor's last report: its verdict (HEALTHY / DEGRADED / UNHEALTHY with the failure streak), the last probe
   * (latency, HTTP status, and the region's database snapshot: role, epoch, log positions, lag) and when it was
   * observed. Null when the region hasn't reported yet, or only reported before the last failover ended (those
   * reports describe the old roles, so regionFacts() withholds them).
   */
  health: RegionHealthSnapshot | null;
  /**
   * Whether the region's compute runs, as far as the sentry knows: 'stopped' after the sentry fenced it (STONITH),
   * 'starting' during a recovery, 'running' once it answered, 'unknown' at first.
   */
  compute: ComputeState;
}

/** Everything a decision may look at. Built fresh for every evaluation by SentryState.decisionContext(). */
export interface DecisionContext {
  /** Workflow time (Date.now() inside the workflow): deterministic, and the same on replay. */
  nowMs: number;
  /** The region the sentry considers primary, the one the edge should route to. */
  activeRegionId: RegionId;
  /** Every configured region, in configuration order. */
  regions: readonly RegionFacts[];
  healthPolicy: HealthPolicy;
  failoverPolicy: FailoverPolicy;
}

// ---------------------------------------------------------------------------------------------------------------------
// Freshness: is a monitor's last report recent enough to act on?
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Monitors report on every change and at least every `reportEveryProbes` probes, so a snapshot older than that
 * (with margin) means the monitor itself is not reporting, and its verdict can't be trusted.
 *
 * The limit is one full reporting period plus two probes, times 1.5. With the deployed defaults (a probe every 30 s,
 * a report at least every 10 probes) that is 30 s × 12 × 1.5 = 9 minutes. With the local configuration (5 s, every
 * 6 probes) it is 60 s.
 *
 * Staleness is what makes the sentry a careful witness. If the monitors go quiet (the worker can't reach Temporal,
 * a monitor is restarting), snapshots age out, regions stop qualifying as targets, the primary's UNHEALTHY verdict
 * stops counting, and the sentry does nothing rather than act on old news.
 */
export function stalenessLimitMs(policy: HealthPolicy): number {
  return Math.round(policy.probeIntervalSeconds * 1000 * (policy.reportEveryProbes + 2) * 1.5);
}

/**
 * Whether a health snapshot is recent enough to base a decision on (see stalenessLimitMs). Used by every decision in
 * this file: target eligibility, the automatic failover trigger and reconciliation.
 */
export function isFresh(
  snapshot: RegionHealthSnapshot,
  context: Pick<DecisionContext, 'nowMs' | 'healthPolicy'>,
): boolean {
  return context.nowMs - Date.parse(snapshot.observedAt) <= stalenessLimitMs(context.healthPolicy);
}

// ---------------------------------------------------------------------------------------------------------------------
// Failover targets
// ---------------------------------------------------------------------------------------------------------------------

/** The chosen standby with a human-readable reason, or null with the reason no standby qualified. */
export type TargetChoice = { regionId: RegionId; reason: string } | { regionId: null; reason: string };

/**
 * The best standby to fail over to: HEALTHY (or DEGRADED when allowed), freshly observed, compute running, its
 * database a replica. Ties go to the smallest replication lag, then the most data, then configuration order.
 *
 * Called by decideAutomaticFailover() (HEALTHY standbys only: an automatic failover must not move traffic to a
 * region that is itself struggling) and by the triggerFailover Update's validator and handler (validators.ts
 * resolveManualTarget) when the operator didn't name a target. A forced manual failover allows DEGRADED: the
 * operator has judged that a degraded region beats the current one.
 *
 * The reason strings end up in the timeline, the alerts and the console's error messages. When nothing qualifies,
 * the reason lists every region and why it was rejected, e.g. "no eligible standby (west: UNHEALTHY)".
 *
 * `exclude` leaves regions out of consideration; nothing passes it today.
 */
export function chooseFailoverTarget(
  context: DecisionContext,
  options: { allowDegraded?: boolean; exclude?: readonly RegionId[] } = {},
): TargetChoice {
  const rejected: string[] = [];
  // The active region is never a candidate (it is what we are failing over from), and isn't listed as rejected.
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
  // Rank the survivors. Least lag first: the replica closest to the primary loses the fewest transactions in a
  // forced failover, and catches up fastest in a planned one. An unknown lag ranks last. Then the most applied log
  // positions (more data), then configuration order, so that the choice is stable between evaluations.
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

/**
 * Why a standby can't be a failover target, or null when it can. The checks run from the cheapest and most decisive
 * down, and the first one that fails is the reason reported:
 *
 * 1. Its compute is stopped or starting: the sentry fenced it, or a recovery is under way. It can't serve yet.
 * 2. It has never been observed, or only before the last failover ended: nothing to judge it by.
 * 3. Its monitor stopped reporting: its last verdict can't be trusted (see stalenessLimitMs).
 * 4. Its verdict isn't good enough: HEALTHY, or DEGRADED when allowed.
 * 5. Its database state is unknown (the last probe got no database snapshot).
 * 6. Its database isn't a replica. A standby that already claims to be primary is a split brain for reconciliation
 *    to fence first, not a target to promote.
 *
 * Called only by chooseFailoverTarget().
 */
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

/**
 * How long the sentry waits before trying again after an automatic failover was refused at its precheck: four probe
 * intervals (long enough for the restarted monitors to observe both regions again), doubling with every further
 * refusal in a row, and never longer than the cooldown. With the deployed defaults (30 s probes, a 10-minute
 * cooldown): 2, 4 and 8 minutes, then 10. Null when nothing was refused.
 *
 * A refused failover moved nothing, so the cooldown (which exists to stop traffic from flapping) doesn't apply; but
 * retrying at once would refuse again just as quickly when the target only looks healthy to its monitor (a flaky
 * region), with alerts every time. Called by the sentry (SentryState's refusal count and time) for the decision
 * and for the console's "cooling down until".
 */
export function refusalBackoffUntilMs(
  refusals: number,
  lastRefusalAtMs: number | null,
  healthPolicy: HealthPolicy,
  failoverPolicy: FailoverPolicy,
): number | null {
  if (refusals <= 0 || lastRefusalAtMs === null) {
    return null;
  }
  const backoffMs = healthPolicy.probeIntervalSeconds * 4_000 * 2 ** Math.min(refusals - 1, 10);
  return lastRefusalAtMs + Math.min(backoffMs, failoverPolicy.cooldownSeconds * 1000);
}

/**
 * What evaluateAutomaticFailover() (sentry.ts) should do:
 * - none: the primary is fine, or its UNHEALTHY verdict is stale. Nothing to do (and the report-once flags reset).
 * - cooldown: the primary is UNHEALTHY, but an automatic failover happened too recently, or the last one was refused
 *   and its back-off hasn't passed. Recorded once; the sentry re-evaluates when `untilMs` comes.
 * - no-target: the primary is UNHEALTHY, but no standby qualifies. A critical alert, raised once.
 * - failover: start an automatic failover to targetRegionId (the sentry sets its pending trigger).
 */
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
 *
 * Called by the sentry's evaluateAutomaticFailover() after every health report, and when an operator turns automatic
 * failover back on. The sentry only calls it in NORMAL mode, with automatic failover enabled and no failover running
 * or pending; those guards live there, not here.
 *
 * The rules, in order:
 *
 * 1. The active region's verdict must be UNHEALTHY and fresh. UNHEALTHY comes from the monitor's window
 *    (health.ts): `failureThreshold` consecutive failed probes. DEGRADED (slow, or some failures) is never enough:
 *    failing over has a cost (a brief outage, possibly lost transactions), so the sentry tolerates a limping primary.
 * 2. No automatic failover within `cooldownSeconds` of the last one that got past its precheck. This prevents
 *    flapping: if the new primary also turns out to be unhealthy (a shared dependency is down, say), the sentry
 *    doesn't bounce traffic back and forth. Manual failovers don't start the cooldown and aren't subject to it.
 *    After a refused automatic failover (nothing moved), the shorter back-off of refusalBackoffUntilMs applies
 *    instead (`refusalBackoffUntilMs` in the context).
 * 3. A standby must qualify (chooseFailoverTarget, HEALTHY only).
 *
 * The decision proposes the most conservative mode, forced (it doesn't count on the old primary). The failover's
 * precheck (failover.ts) then probes live: if the old primary's database still answers and the target is replicating
 * from it, it upgrades to planned, which loses nothing.
 */
export function decideAutomaticFailover(
  context: DecisionContext & {
    lastAutomaticFailoverAtMs: number | null;
    refusalBackoffUntilMs?: number | null;
  },
): AutomaticDecision {
  const active = context.regions.find((region) => region.id === context.activeRegionId);
  const health = active?.health;
  // Rule 1. A stale UNHEALTHY verdict doesn't count: the monitor may be the one that is broken.
  if (!active || !health || health.status !== 'UNHEALTHY' || !isFresh(health, context)) {
    return { kind: 'none' };
  }
  // Rule 2.
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
  // Rule 2, after a refusal: the back-off.
  const backoffUntilMs = context.refusalBackoffUntilMs ?? null;
  if (backoffUntilMs !== null && context.nowMs < backoffUntilMs) {
    return {
      kind: 'cooldown',
      untilMs: backoffUntilMs,
      reason: `the last automatic failover was refused at its precheck; trying again after ${new Date(backoffUntilMs).toISOString()}`,
    };
  }
  // Rule 3. "No target" is also the witness property at work: if every region looks unhealthy to the sentry, the
  // sentry's own view is the likeliest fault, and moving traffic would not help.
  const target = chooseFailoverTarget(context);
  if (target.regionId === null) {
    return { kind: 'no-target', reason: `${active.displayName} is UNHEALTHY, but ${target.reason}` };
  }
  // The reason is what the alert, the timeline and the failover record show, so it says why in plain terms.
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

/**
 * One corrective action, carried out by the sentry's reconcile() (sentry.ts). The intent is: exactly one primary
 * database, in the active region, and the edge routing to it at the current epoch.
 */
export type ReconcileAction =
  /** A region other than the active one claims to be primary: the stale side of a split brain. */
  | { kind: 'fence-stale-primary'; regionId: RegionId; reportedEpoch: number }
  /** No database is primary (first start, or the active region restarted): re-promote the active region's. */
  | { kind: 'restore-active-primary'; regionId: RegionId; epochFloor: number }
  /** The active region lost its data but a standby holds newer data: move to the standby instead. */
  | { kind: 'failover-to-freshest'; regionId: RegionId; reason: string }
  /** The edge doesn't route to the active region at the current epoch. */
  | { kind: 'sync-edge'; regionId: RegionId };

/**
 * The single most important thing to correct, or null when reality matches intent (or can't be judged).
 *
 * Called by the sentry's reconciliationPlan(), which the reconciler loop (reconcileLoop, sentry.ts) evaluates inside a
 * condition. Temporal re-checks the condition after every event, so in practice it re-runs whenever a health report
 * arrives. The loop carries out one action, waits two probe intervals for the monitors to observe the effect, then
 * plans again; a situation with several problems is corrected step by step, in the order below. The sentry never
 * reconciles during a failover: the failover owns the databases and the edge then.
 *
 * Only "usable" evidence counts: a fresh report whose last probe succeeded and included the database's state. A
 * region that is down or unobserved is neither fenced nor trusted; the automatic failover path deals with a down
 * primary.
 *
 * In order of precedence:
 *
 * 1. Fence a stale primary. Any non-active region whose database says primary is demoted first, since two primaries
 *    accepting writes is the worst state there is. (The edge never routed to it; this stops it diverging further.)
 * 2. If the active region's evidence isn't usable, stop: there is nothing safe to conclude about it.
 * 3. The active region's database is a replica and isn't being promoted, so no database is primary. This happens on
 *    a first start, or after the active region restarted (the simulated database lives in memory and comes back
 *    empty, as a replica). Two cases:
 *    - A standby holds more data (a higher applied log position): promoting the empty active region would throw that
 *      data away, so fail over to the freshest region instead (planned: nothing to lose).
 *    - Otherwise, promote the active region's database ("restore"), under an epoch above every epoch the sentry or
 *      any region has seen (epochFloor + 1), so that every node accepts the order.
 * 4. The active database is primary, but the edge doesn't route to it, isn't active, or holds an older epoch: rewrite
 *    the routing. The routing is only ever pointed at a database that reports primary.
 */
export function planReconciliation(
  context: DecisionContext & { epoch: number; edge: EdgeRouting | null },
): ReconcileAction | null {
  /** Fresh, and the last probe answered with the database's state: evidence worth acting on. */
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

  // 1. Split brain: a standby claims to be primary. The first one found is fenced; the next pass finds any others.
  for (const region of others) {
    const db = usable(region) ? region.health.lastProbe?.db : null;
    if (db?.role === 'primary') {
      return { kind: 'fence-stale-primary', regionId: region.id, reportedEpoch: db.epoch };
    }
  }

  // 2. Nothing to conclude about an active region we can't see clearly.
  if (!usable(active)) {
    return null;
  }
  const activeDb = active.health.lastProbe?.db;
  if (!activeDb) {
    return null;
  }

  // 3. No primary. A promotion already under way (a restore just ordered, say) is left to finish.
  const promoting =
    activeDb.promotion?.status === 'catching-up' || activeDb.promotion?.status === 'switching';
  if (activeDb.role === 'replica' && !promoting) {
    // The active region is listed first, so on a tie it stays: no failover for nothing.
    const contenders = [active, ...others.filter(usable)];
    const freshest = contenders.reduce((best, region) =>
      (region.health?.lastProbe?.db?.appliedLsn ?? 0) > (best.health?.lastProbe?.db?.appliedLsn ?? 0)
        ? region
        : best,
    );
    // Above the sentry's epoch and every epoch a region reports, so the restore order can't be refused as stale.
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

  // 4. The primary is right; make the edge agree. An edge at an older epoch is rewritten even if it already points
  // at the right region, so that its fencing floor matches the current epoch.
  const edge = context.edge;
  if (
    activeDb.role === 'primary' &&
    (!edge || edge.mode !== 'active' || edge.activeRegionId !== active.id || edge.epoch < context.epoch)
  ) {
    return { kind: 'sync-edge', regionId: active.id };
  }
  return null;
}
