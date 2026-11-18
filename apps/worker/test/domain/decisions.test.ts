import { describe, expect, it } from 'vitest';
import {
  chooseFailoverTarget,
  decideAutomaticFailover,
  planReconciliation,
  stalenessLimitMs,
  type DecisionContext,
  type RegionFacts,
} from '../../src/domain/decisions.js';
import { failoverPolicy, healthPolicy, NOW, region, snapshot } from '../helpers/fixtures.js';

function context(regions: RegionFacts[], overrides: Partial<DecisionContext> = {}): DecisionContext {
  return { nowMs: NOW, activeRegionId: 'east', regions, healthPolicy, failoverPolicy, ...overrides };
}

const primaryDb = { role: 'primary' as const, epoch: 2, lagSeconds: null };

describe('chooseFailoverTarget', () => {
  it('prefers the healthy standby with the least lag, then the most data, then configuration order', () => {
    const regions = [
      region('east', snapshot('east', 'HEALTHY', { db: primaryDb })),
      region('west', snapshot('west', 'HEALTHY', { db: { lagSeconds: 4 } }), { order: 1 }),
      region('north', snapshot('north', 'HEALTHY', { db: { lagSeconds: 1, appliedLsn: 90 } }), { order: 2 }),
      region('south', snapshot('south', 'HEALTHY', { db: { lagSeconds: 1, appliedLsn: 95 } }), { order: 3 }),
    ];
    expect(chooseFailoverTarget(context(regions)).regionId).toBe('south');
  });

  it('skips unhealthy, stopped, stale or primary standbys and explains why', () => {
    const regions = [
      region('east', snapshot('east', 'UNHEALTHY')),
      region('west', snapshot('west', 'UNHEALTHY')),
      region('north', snapshot('north', 'HEALTHY'), { compute: 'stopped' }),
      region('south', snapshot('south', 'HEALTHY', { observedAt: '2025-12-31T00:00:00.000Z' })),
      region('central', snapshot('central', 'HEALTHY', { db: primaryDb })),
    ];
    const choice = chooseFailoverTarget(context(regions));
    expect(choice.regionId).toBeNull();
    expect(choice.reason).toContain('west: UNHEALTHY');
    expect(choice.reason).toContain('north: compute stopped');
    expect(choice.reason).toContain('south: monitor not reporting');
    expect(choice.reason).toContain('central: database is primary');
  });

  it('accepts a degraded standby only when allowed', () => {
    const regions = [
      region('east', snapshot('east', 'HEALTHY')),
      region('west', snapshot('west', 'DEGRADED')),
    ];
    expect(chooseFailoverTarget(context(regions)).regionId).toBeNull();
    expect(chooseFailoverTarget(context(regions), { allowDegraded: true }).regionId).toBe('west');
  });
});

describe('decideAutomaticFailover', () => {
  const healthyStandby = region('west', snapshot('west', 'HEALTHY'), { order: 1 });

  it('does nothing while the primary is not UNHEALTHY', () => {
    const regions = [region('east', snapshot('east', 'DEGRADED')), healthyStandby];
    expect(decideAutomaticFailover({ ...context(regions), lastAutomaticFailoverAtMs: null })).toEqual({
      kind: 'none',
    });
  });

  it('fails over (forced) to a healthy standby when the primary is UNHEALTHY', () => {
    const regions = [region('east', snapshot('east', 'UNHEALTHY')), healthyStandby];
    const decision = decideAutomaticFailover({ ...context(regions), lastAutomaticFailoverAtMs: null });
    expect(decision).toMatchObject({ kind: 'failover', targetRegionId: 'west', mode: 'forced' });
    expect(decision.kind === 'failover' && decision.reason).toContain('3 consecutive failed probes');
  });

  it('respects the cooldown between automatic failovers', () => {
    const regions = [region('east', snapshot('east', 'UNHEALTHY')), healthyStandby];
    const decision = decideAutomaticFailover({
      ...context(regions),
      lastAutomaticFailoverAtMs: NOW - 10_000,
    });
    expect(decision).toMatchObject({ kind: 'cooldown', untilMs: NOW + 50_000 });
  });

  it('reports when there is no healthy target, and ignores stale verdicts', () => {
    const noTarget = [
      region('east', snapshot('east', 'UNHEALTHY')),
      region('west', snapshot('west', 'UNHEALTHY')),
    ];
    expect(decideAutomaticFailover({ ...context(noTarget), lastAutomaticFailoverAtMs: null }).kind).toBe(
      'no-target',
    );
    const stale = [
      region(
        'east',
        snapshot('east', 'UNHEALTHY', {
          observedAt: new Date(NOW - stalenessLimitMs(healthPolicy) - 1).toISOString(),
        }),
      ),
      healthyStandby,
    ];
    expect(decideAutomaticFailover({ ...context(stale), lastAutomaticFailoverAtMs: null }).kind).toBe('none');
  });
});

describe('planReconciliation', () => {
  const base = { epoch: 2, edge: null };

  it('fences a standby that claims to be primary (split brain)', () => {
    const regions = [
      region('east', snapshot('east', 'HEALTHY', { db: primaryDb })),
      region('west', snapshot('west', 'HEALTHY', { db: { role: 'primary', epoch: 1 } })),
    ];
    expect(planReconciliation({ ...context(regions), ...base })).toEqual({
      kind: 'fence-stale-primary',
      regionId: 'west',
      reportedEpoch: 1,
    });
  });

  it('restores the active primary when no database is primary (first start)', () => {
    const regions = [
      region('east', snapshot('east', 'HEALTHY', { db: { epoch: 0, appliedLsn: 0 } })),
      region('west', snapshot('west', 'HEALTHY', { db: { epoch: 0, appliedLsn: 0 } })),
    ];
    expect(planReconciliation({ ...context(regions), epoch: 0, edge: null })).toEqual({
      kind: 'restore-active-primary',
      regionId: 'east',
      epochFloor: 0,
    });
  });

  it('moves to the standby when the active region lost its data', () => {
    const regions = [
      region('east', snapshot('east', 'HEALTHY', { db: { epoch: 0, appliedLsn: 0 } })),
      region('west', snapshot('west', 'HEALTHY', { db: { epoch: 2, appliedLsn: 500 } })),
    ];
    expect(planReconciliation({ ...context(regions), ...base })).toMatchObject({
      kind: 'failover-to-freshest',
      regionId: 'west',
    });
  });

  it('syncs the edge once the active database is primary', () => {
    const regions = [
      region('east', snapshot('east', 'HEALTHY', { db: primaryDb })),
      region('west', snapshot('west', 'HEALTHY')),
    ];
    expect(planReconciliation({ ...context(regions), ...base })).toEqual({
      kind: 'sync-edge',
      regionId: 'east',
    });
    const edge = {
      mode: 'active' as const,
      activeRegionId: 'east',
      epoch: 2,
      version: 7,
      failoverId: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(planReconciliation({ ...context(regions), epoch: 2, edge })).toBeNull();
  });

  it('acts only on fresh, successful observations', () => {
    const regions = [
      region('east', snapshot('east', 'UNHEALTHY', { db: { epoch: 0 } })),
      region('west', snapshot('west', 'HEALTHY')),
    ];
    expect(planReconciliation({ ...context(regions), ...base })).toBeNull();
  });
});
