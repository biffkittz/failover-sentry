import type {
  DatabaseSnapshot,
  FailoverPolicy,
  HealthPolicy,
  HealthStatus,
  ProbeResult,
  RegionHealthSnapshot,
  SentryConfig,
} from '@failover-sentry/contracts';
import type { RegionFacts } from '../../src/domain/decisions.js';

export const healthPolicy: HealthPolicy = {
  probeIntervalSeconds: 1,
  probeTimeoutMs: 1_000,
  failureThreshold: 3,
  degradedLatencyMs: 500,
  windowSize: 10,
  reportEveryProbes: 5,
};

export const failoverPolicy: FailoverPolicy = {
  autoFailoverEnabled: true,
  cooldownSeconds: 60,
  replicationTimeoutSeconds: 5,
  stallEscalationSeconds: 5,
  edgePropagationTimeoutSeconds: 10,
  stabilizationSeconds: 2,
  stabilizationProbeIntervalSeconds: 1,
  stabilizationFailureThreshold: 2,
  fenceComputeOnForcedFailover: true,
};

export function db(overrides: Partial<DatabaseSnapshot> = {}): DatabaseSnapshot {
  return {
    role: 'replica',
    epoch: 1,
    lsn: 100,
    appliedLsn: 100,
    lagSeconds: 0,
    promotion: null,
    ...overrides,
  };
}

export function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    regionId: 'east',
    at: '2026-01-01T00:00:00.000Z',
    ok: true,
    latencyMs: 50,
    httpStatus: 200,
    error: null,
    reportedStatus: 'ok',
    version: 'test',
    db: db(),
    chaos: null,
    ...overrides,
  };
}

export function snapshot(
  regionId: string,
  status: HealthStatus,
  options: { db?: Partial<DatabaseSnapshot>; observedAt?: string; ok?: boolean; failures?: number } = {},
): RegionHealthSnapshot {
  return {
    regionId,
    status,
    consecutiveFailures: options.failures ?? (status === 'UNHEALTHY' ? 3 : 0),
    consecutiveSlow: 0,
    windowSuccessRate: status === 'HEALTHY' ? 1 : 0.5,
    medianLatencyMs: 50,
    probesInWindow: 10,
    lastProbe: probe({
      regionId,
      ok: options.ok ?? status !== 'UNHEALTHY',
      db: db(options.db),
      ...(status === 'UNHEALTHY' ? { httpStatus: 503, error: 'HTTP 503' } : {}),
    }),
    observedAt: options.observedAt ?? '2026-01-01T00:00:00.000Z',
    monitorInstanceId: `${regionId}-monitor`,
    sequence: 1,
  };
}

export function region(
  id: string,
  health: RegionHealthSnapshot | null,
  overrides: Partial<RegionFacts> = {},
): RegionFacts {
  return { id, displayName: id.toUpperCase(), order: 0, health, compute: 'running', ...overrides };
}

export const NOW = Date.parse('2026-01-01T00:00:05.000Z');

export function sentryConfig(overrides: Partial<SentryConfig> = {}): SentryConfig {
  return {
    serviceName: 'storefront',
    edgePublicUrl: 'http://edge.test',
    consoleUrl: 'http://console.test',
    initialPrimaryRegionId: 'east',
    regions: [
      { id: 'east', displayName: 'East', provider: 'local', baseUrl: 'http://east.test' },
      { id: 'west', displayName: 'West', provider: 'local', baseUrl: 'http://west.test' },
    ],
    health: healthPolicy,
    failover: failoverPolicy,
    ...overrides,
  };
}
