/**
 * Turns a rolling window of probes into a health verdict. Pure and deterministic: monitor workflows call it, and
 * the same inputs always give the same verdict on replay.
 */
import type { HealthPolicy, HealthStatus, ProbeResult } from '@failover-sentry/contracts';

export interface HealthAssessment {
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSlow: number;
  windowSuccessRate: number;
  medianLatencyMs: number | null;
  probesInWindow: number;
}

/** Below this share of successful probes in the window, a region is DEGRADED even without a failure streak. */
export const DEGRADED_SUCCESS_RATE = 0.8;

/** Slow probes in a row that make a region DEGRADED. */
export const SLOW_STREAK_FOR_DEGRADED = 2;

export function evaluateHealth(probes: readonly ProbeResult[], policy: HealthPolicy): HealthAssessment {
  const window = probes.slice(-policy.windowSize);
  if (window.length === 0) {
    return {
      status: 'UNKNOWN',
      consecutiveFailures: 0,
      consecutiveSlow: 0,
      windowSuccessRate: 0,
      medianLatencyMs: null,
      probesInWindow: 0,
    };
  }

  const consecutiveFailures = streakFromEnd(window, (probe) => !probe.ok);
  const consecutiveSlow = streakFromEnd(
    window,
    (probe) => probe.ok && probe.latencyMs > policy.degradedLatencyMs,
  );
  const successes = window.filter((probe) => probe.ok);
  const windowSuccessRate = successes.length / window.length;
  const last = window[window.length - 1];

  let status: HealthStatus;
  if (consecutiveFailures >= policy.failureThreshold) {
    status = 'UNHEALTHY';
  } else if (
    consecutiveFailures > 0 ||
    consecutiveSlow >= SLOW_STREAK_FOR_DEGRADED ||
    last?.reportedStatus === 'degraded' ||
    windowSuccessRate < DEGRADED_SUCCESS_RATE
  ) {
    status = 'DEGRADED';
  } else {
    status = 'HEALTHY';
  }

  return {
    status,
    consecutiveFailures,
    consecutiveSlow,
    windowSuccessRate: Math.round(windowSuccessRate * 1000) / 1000,
    medianLatencyMs: median(successes.map((probe) => probe.latencyMs)),
    probesInWindow: window.length,
  };
}

function streakFromEnd(probes: readonly ProbeResult[], predicate: (probe: ProbeResult) => boolean): number {
  let count = 0;
  for (let index = probes.length - 1; index >= 0; index -= 1) {
    const probe = probes[index];
    if (!probe || !predicate(probe)) {
      break;
    }
    count += 1;
  }
  return count;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(value ?? 0);
}

/** A key that changes whenever the database facts the sentry acts on change (role, epoch, promotion state). */
export function databaseKey(probe: ProbeResult | null | undefined): string | null {
  const db = probe?.db;
  if (!db) {
    return null;
  }
  return `${db.role}:${db.epoch}:${db.promotion?.status ?? 'none'}:${db.promotion?.failoverId ?? ''}`;
}
