/** Typed endpoints of the console server. */
import type {
  AbortFailoverResult,
  AlertRecord,
  ChaosSettings,
  ChaosUpdate,
  ConsoleUser,
  FailoverAccepted,
  FailoverMode,
  MonitorStateView,
  RecoverRegionAccepted,
  ResolveStallResult,
  SentryStateView,
  SetAutoFailoverResult,
  StallDecision,
} from '@failover-sentry/contracts';
import { http } from './http';

export type AuthMode = 'github' | 'dev';

export interface Me extends ConsoleUser {
  authMode: AuthMode;
}

export interface ManualFailoverInput {
  targetRegionId?: string | undefined;
  mode: FailoverMode;
  reason: string;
}

export const authApi = {
  me: (signal?: AbortSignal) => http.get<Me>('/api/me', signal ? { signal } : {}),
  logout: () => http.post<void>('/auth/logout'),
  devLogin: () => http.post<void>('/auth/dev/login'),
};

export const sentryApi = {
  state: (signal?: AbortSignal) => http.get<SentryStateView>('/api/sentry', signal ? { signal } : {}),
  start: () => http.post<{ workflowId: string }>('/api/sentry/start'),
  triggerFailover: (input: ManualFailoverInput) => http.post<FailoverAccepted>('/api/sentry/failover', input),
  abortFailover: (reason: string) => http.post<AbortFailoverResult>('/api/sentry/failover/abort', { reason }),
  resolveStall: (decision: StallDecision) =>
    http.post<ResolveStallResult>('/api/sentry/failover/stall', { decision }),
  setAutoFailover: (enabled: boolean) =>
    http.put<SetAutoFailoverResult>('/api/sentry/auto-failover', { enabled }),
  acknowledgeAlert: (alertId: string) =>
    http.post<AlertRecord>(`/api/sentry/alerts/${encodeURIComponent(alertId)}/acknowledge`),
  recoverRegion: (regionId: string) =>
    http.post<RecoverRegionAccepted>(`/api/regions/${encodeURIComponent(regionId)}/recover`),
  monitor: (regionId: string, signal?: AbortSignal) =>
    http.get<MonitorStateView>(
      `/api/regions/${encodeURIComponent(regionId)}/monitor`,
      signal ? { signal } : {},
    ),
  chaos: (regionId: string, signal?: AbortSignal) =>
    http.get<ChaosSettings>(`/api/regions/${encodeURIComponent(regionId)}/chaos`, signal ? { signal } : {}),
  updateChaos: (regionId: string, update: ChaosUpdate) =>
    http.put<ChaosSettings>(`/api/regions/${encodeURIComponent(regionId)}/chaos`, update),
};

export const STREAM_URL = '/api/sentry/stream';
