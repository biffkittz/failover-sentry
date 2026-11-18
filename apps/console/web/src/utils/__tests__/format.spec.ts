import { describe, expect, it } from 'vitest';
import { duration, phaseLabel, relativeTime } from '@/utils/format';

describe('format', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');

  it('formats relative times in the past and future', () => {
    expect(relativeTime('2026-01-01T11:59:58.000Z', now)).toBe('just now');
    expect(relativeTime('2026-01-01T11:59:30.000Z', now)).toBe('30s ago');
    expect(relativeTime('2026-01-01T11:50:00.000Z', now)).toBe('10m ago');
    expect(relativeTime('2026-01-01T12:05:00.000Z', now)).toBe('in 5m');
    expect(relativeTime(null, now)).toBe('never');
  });

  it('formats durations and phases', () => {
    expect(duration('2026-01-01T11:58:55.000Z', '2026-01-01T12:00:00.000Z')).toBe('1m 5s');
    expect(duration('2026-01-01T11:59:50.000Z', null, now)).toBe('10s');
    expect(phaseLabel('AWAITING_OPERATOR')).toBe('Waiting for an operator decision');
    expect(phaseLabel('SWITCH_EDGE')).toBe('Switch edge routing');
  });
});
