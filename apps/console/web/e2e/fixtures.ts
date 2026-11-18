import { test as base, expect, type Page } from '@playwright/test';

const now = () => new Date().toISOString();

export function sentryState(overrides: Record<string, unknown> = {}) {
  const region = (id: string, primary: boolean) => ({
    config: {
      id,
      displayName: primary ? 'East US 2' : 'Central US',
      provider: 'azure',
      baseUrl: `https://${id}.example.net`,
    },
    role: primary ? 'PRIMARY' : 'STANDBY',
    compute: 'running',
    recovery: null,
    health: {
      regionId: id,
      status: 'HEALTHY',
      consecutiveFailures: 0,
      consecutiveSlow: 0,
      windowSuccessRate: 1,
      medianLatencyMs: 45,
      probesInWindow: 10,
      observedAt: now(),
      monitorInstanceId: `${id}-m`,
      sequence: 4,
      lastProbe: {
        regionId: id,
        at: now(),
        ok: true,
        latencyMs: 45,
        httpStatus: 200,
        error: null,
        reportedStatus: 'ok',
        version: '1.0.0',
        chaos: null,
        db: {
          role: primary ? 'primary' : 'replica',
          epoch: 5,
          lsn: 900,
          appliedLsn: 900,
          lagSeconds: primary ? null : 0,
          promotion: null,
        },
      },
    },
  });
  return {
    workflowId: 'failover-sentry/storefront',
    runId: 'run-1',
    serviceName: 'storefront',
    configVersion: 'v1',
    mode: 'NORMAL',
    epoch: 5,
    activeRegionId: 'eastus2',
    autoFailoverEnabled: true,
    autoFailoverSuspendedReason: null,
    cooldownUntil: null,
    regions: [region('eastus2', true), region('centralus', false)],
    edge: {
      mode: 'active',
      activeRegionId: 'eastus2',
      epoch: 5,
      version: 12,
      failoverId: null,
      updatedAt: now(),
    },
    currentFailover: null,
    recentFailovers: [],
    alerts: [
      {
        id: 'al-3',
        kind: 'SPLIT_BRAIN_FENCED',
        severity: 'critical',
        title: 'Split brain fenced: Central US',
        message: 'Central US still claimed to be primary; the sentry demoted it.',
        at: now(),
        failoverId: null,
        regionId: 'centralus',
        delivery: 'sent',
        deliveryDetail: 'emailed 1 recipient(s)',
        acknowledgedBy: null,
        acknowledgedAt: null,
      },
    ],
    timeline: [
      {
        id: 'ev-1',
        at: now(),
        kind: 'EDGE_SYNCED',
        message: 'The edge routes to East US 2',
        severity: 'info',
        failoverId: null,
        regionId: 'eastus2',
      },
    ],
    health: {
      probeIntervalSeconds: 30,
      probeTimeoutMs: 5000,
      failureThreshold: 3,
      degradedLatencyMs: 1500,
      windowSize: 10,
      reportEveryProbes: 10,
    },
    failoverPolicy: {
      autoFailoverEnabled: true,
      cooldownSeconds: 600,
      replicationTimeoutSeconds: 120,
      stallEscalationSeconds: 600,
      edgePropagationTimeoutSeconds: 180,
      stabilizationSeconds: 90,
      stabilizationProbeIntervalSeconds: 10,
      stabilizationFailureThreshold: 3,
      fenceComputeOnForcedFailover: true,
    },
    edgePublicUrl: 'https://dr.biffkittz.com',
    startedAt: now(),
    runStartedAt: now(),
    continuedAsNewCount: 0,
    historyLength: 321,
    updatedAt: now(),
    ...overrides,
  };
}

/** Mocks the console API as a signed-in operator, with the given sentry state on the stream. */
export async function mockSignedIn(page: Page, state = sentryState()): Promise<void> {
  await page.route('**/api/me', (route) =>
    route.fulfill({ json: { login: 'octocat', name: 'Mona Lisa', avatarUrl: null, authMode: 'github' } }),
  );
  await page.route('**/api/sentry/stream', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: `retry: 60000\n\nevent: state\ndata: ${JSON.stringify(state)}\n\n`,
    }),
  );
  await page.route('**/api/regions/*/monitor', (route) =>
    route.fulfill({
      json: {
        regionId: 'eastus2',
        role: 'PRIMARY',
        status: 'HEALTHY',
        probes: [],
        consecutiveFailures: 0,
        startedAt: now(),
        iterations: 3,
        continuedAsNewCount: 0,
      },
    }),
  );
  await page.route('**/api/client-errors', (route) => route.fulfill({ status: 204 }));
}

export const test = base;
export { expect };
