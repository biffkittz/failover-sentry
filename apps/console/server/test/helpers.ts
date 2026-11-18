import type { ConsoleUser, SentryStateView } from '@failover-sentry/contracts';
import { vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GitHubClient } from '../src/auth/github.js';
import type { ConsoleConfig } from '../src/config.js';
import type { ChaosService } from '../src/services/chaos-service.js';
import type { SentryGateway } from '../src/services/sentry-gateway.js';

export const PUBLIC_URL = 'https://sentry.example.com';

export function testConfig(overrides: Partial<ConsoleConfig> = {}): ConsoleConfig {
  return {
    production: false,
    port: 0,
    host: '127.0.0.1',
    publicUrl: new URL(PUBLIC_URL),
    sentry: {
      serviceName: 'storefront',
      edgePublicUrl: 'https://dr.example.com',
      consoleUrl: PUBLIC_URL,
      initialPrimaryRegionId: 'east',
      regions: [
        { id: 'east', displayName: 'East', provider: 'local', baseUrl: 'http://east.test' },
        { id: 'west', displayName: 'West', provider: 'local', baseUrl: 'http://west.test' },
      ],
      health: {
        probeIntervalSeconds: 30,
        probeTimeoutMs: 5_000,
        failureThreshold: 3,
        degradedLatencyMs: 1_500,
        windowSize: 10,
        reportEveryProbes: 10,
      },
      failover: {
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
    },
    taskQueue: 'failover-sentry',
    sessionSecret: 'test-session-secret-with-at-least-32-chars',
    sessionTtlSeconds: 3600,
    auth: { mode: 'github', clientId: 'client-id', clientSecret: 'client-secret', allowedUsers: ['octocat'] },
    webhookSecrets: ['webhook-secret-0123456789'],
    regionAdminSecret: 'region-admin-secret-0123',
    webDistDir: '/nonexistent',
    statePollIntervalMs: 50,
    logLevel: 'silent',
    ...overrides,
  };
}

export function fakeGateway(state: Partial<SentryStateView> | null = { epoch: 1 }) {
  return {
    workflowId: 'failover-sentry/storefront',
    getState: vi.fn(async () => state as SentryStateView | null),
    getMonitor: vi.fn(),
    ensureRunning: vi.fn(async () => undefined),
    triggerFailover: vi.fn(async (input: { mode: string; requestedBy: string }) => ({
      failoverId: 'fo-1',
      epoch: 2,
      fromRegionId: 'east',
      toRegionId: 'west',
      mode: input.mode,
    })),
    abortFailover: vi.fn(async () => ({ failoverId: 'fo-1', abortedDuringPhase: 'AWAIT_REPLICATION' })),
    resolveStall: vi.fn(),
    setAutoFailover: vi.fn(async (input: { enabled: boolean }) => ({ autoFailoverEnabled: input.enabled })),
    acknowledgeAlert: vi.fn(),
    recoverRegion: vi.fn(),
    signalReplicationComplete: vi.fn(async () => undefined),
    ping: vi.fn(async () => undefined),
  } satisfies Record<keyof SentryGateway, unknown>;
}

export function fakeGitHub(
  user: ConsoleUser = { login: 'octocat', name: 'Mona', avatarUrl: null },
): GitHubClient {
  return {
    authorizeUrl: ({ state, challenge, redirectUri }) =>
      `https://github.com/login/oauth/authorize?state=${state}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: vi.fn(async () => 'gho_token'),
    fetchUser: vi.fn(async () => user),
    revokeToken: vi.fn(async () => undefined),
  };
}

export const fakeChaos: ChaosService = {
  get: vi.fn(async () => ({
    health: 'healthy' as const,
    latencyMs: 0,
    errorRate: 0,
    replication: 'normal' as const,
  })),
  update: vi.fn(async (_regionId, update) => ({
    health: 'healthy' as const,
    latencyMs: 0,
    errorRate: 0,
    replication: 'normal' as const,
    ...update,
  })),
};

export async function testApp(
  options: { config?: ConsoleConfig; gateway?: ReturnType<typeof fakeGateway>; github?: GitHubClient } = {},
) {
  const gateway = options.gateway ?? fakeGateway();
  const app = await buildApp({
    config: options.config ?? testConfig(),
    gateway: gateway as unknown as SentryGateway,
    chaos: fakeChaos,
    github: options.github ?? fakeGitHub(),
    serveStatic: false,
    sseHeartbeatMs: 50,
  });
  return { app, gateway };
}

/** Cookies from a response, as a Cookie request header. */
export function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(';')[0]).join('; ');
}

export const csrf = { 'x-sentry-csrf': '1', origin: PUBLIC_URL };
