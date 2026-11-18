import { describe, expect, it } from 'vitest';
import { databaseKey, evaluateHealth, median } from '../../src/domain/health.js';
import { db, healthPolicy, probe } from '../helpers/fixtures.js';

describe('evaluateHealth', () => {
  it('is UNKNOWN without probes', () => {
    expect(evaluateHealth([], healthPolicy).status).toBe('UNKNOWN');
  });

  it('is HEALTHY when recent probes succeed quickly', () => {
    const result = evaluateHealth(
      [probe(), probe({ latencyMs: 70 }), probe({ latencyMs: 60 })],
      healthPolicy,
    );
    expect(result).toMatchObject({
      status: 'HEALTHY',
      consecutiveFailures: 0,
      windowSuccessRate: 1,
      medianLatencyMs: 60,
    });
  });

  it('is DEGRADED after one failure, and UNHEALTHY at the failure threshold', () => {
    const failed = probe({ ok: false, httpStatus: 503, error: 'HTTP 503' });
    expect(evaluateHealth([probe(), failed], healthPolicy).status).toBe('DEGRADED');
    expect(evaluateHealth([probe(), failed, failed], healthPolicy).status).toBe('DEGRADED');
    expect(evaluateHealth([probe(), failed, failed, failed], healthPolicy)).toMatchObject({
      status: 'UNHEALTHY',
      consecutiveFailures: 3,
    });
  });

  it('is DEGRADED on a slow streak, a self-reported degradation, or a poor success rate', () => {
    const slow = probe({ latencyMs: 900 });
    expect(evaluateHealth([probe(), slow, slow], healthPolicy).status).toBe('DEGRADED');
    expect(evaluateHealth([probe({ reportedStatus: 'degraded' })], healthPolicy).status).toBe('DEGRADED');
    const flaky = [probe({ ok: false }), probe(), probe({ ok: false }), probe(), probe(), probe(), probe()];
    expect(evaluateHealth(flaky, healthPolicy).status).toBe('DEGRADED');
  });

  it('only looks at the rolling window', () => {
    const old = Array.from({ length: 5 }, () => probe({ ok: false }));
    const recent = Array.from({ length: 10 }, () => probe());
    expect(evaluateHealth([...old, ...recent], healthPolicy)).toMatchObject({
      status: 'HEALTHY',
      probesInWindow: 10,
    });
  });

  it('computes medians and database keys', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(databaseKey(probe({ db: db({ role: 'primary', epoch: 3 }) }))).toBe('primary:3:none:');
    expect(databaseKey(probe({ db: null }))).toBeNull();
  });
});
