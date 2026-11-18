/**
 * The sentry's live state (pushed over Server-Sent Events) and the operator actions on it. Actions call the API;
 * the workflow then changes and the next pushed snapshot confirms it. Toggles that are safe to predict (automatic
 * failover, alert acknowledgement) update optimistically and roll back if the sentry refuses.
 */
import type {
  AlertRecord,
  FailoverAccepted,
  FailoverRun,
  RegionView,
  SentryStateView,
  StallDecision,
} from '@failover-sentry/contracts';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { sentryApi, type ManualFailoverInput } from '@/api/sentry-api';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export const useSentryStore = defineStore('sentry', () => {
  // State -------------------------------------------------------------------------------------------------------
  /** Replaced wholesale on every push, so it is a shallow ref (no deep reactivity over a large, immutable tree). */
  const state = shallowRef<SentryStateView | null>(null);
  const connection = ref<ConnectionStatus>('idle');
  const unavailableReason = ref<string | null>(null);
  const lastUpdatedAt = ref<number | null>(null);
  const pending = ref<Record<string, boolean>>({});

  // Getters -----------------------------------------------------------------------------------------------------
  const isRunning = computed(() => state.value !== null && unavailableReason.value === null);
  const regions = computed<RegionView[]>(() => state.value?.regions ?? []);
  const activeRegion = computed(() => regions.value.find((region) => region.role === 'PRIMARY') ?? null);
  const standbyRegions = computed(() => regions.value.filter((region) => region.role === 'STANDBY'));
  const currentFailover = computed<FailoverRun | null>(() => state.value?.currentFailover ?? null);
  const isFailoverInProgress = computed(() => currentFailover.value !== null);
  const failovers = computed<FailoverRun[]>(() =>
    currentFailover.value
      ? [currentFailover.value, ...(state.value?.recentFailovers ?? [])]
      : (state.value?.recentFailovers ?? []),
  );
  const alerts = computed<AlertRecord[]>(() => state.value?.alerts ?? []);
  const openAlerts = computed(() => alerts.value.filter((alert) => !alert.acknowledgedBy));
  const openCriticalAlerts = computed(() =>
    openAlerts.value.filter((alert) => alert.severity === 'critical'),
  );
  const canTriggerFailover = computed(
    () => isRunning.value && !isFailoverInProgress.value && standbyRegions.value.length > 0,
  );
  const isStalled = computed(() => currentFailover.value?.phase === 'AWAITING_OPERATOR');

  function regionById(regionId: string): RegionView | undefined {
    return regions.value.find((region) => region.config.id === regionId);
  }

  function failoverById(failoverId: string): FailoverRun | undefined {
    return failovers.value.find((run) => run.id === failoverId);
  }

  // Actions -----------------------------------------------------------------------------------------------------
  function applySnapshot(snapshot: SentryStateView): void {
    state.value = snapshot;
    unavailableReason.value = null;
    lastUpdatedAt.value = Date.now();
  }

  function markUnavailable(reason: string): void {
    unavailableReason.value = reason;
    lastUpdatedAt.value = Date.now();
  }

  function setConnection(status: ConnectionStatus): void {
    connection.value = status;
  }

  async function track<T>(key: string, work: () => Promise<T>): Promise<T> {
    pending.value = { ...pending.value, [key]: true };
    try {
      return await work();
    } finally {
      const { [key]: _done, ...rest } = pending.value;
      pending.value = rest;
    }
  }

  async function refresh(signal?: AbortSignal): Promise<void> {
    applySnapshot(await sentryApi.state(signal));
  }

  function triggerFailover(input: ManualFailoverInput): Promise<FailoverAccepted> {
    return track('failover', () => sentryApi.triggerFailover(input));
  }

  function abortFailover(reason: string) {
    return track('abort', () => sentryApi.abortFailover(reason));
  }

  function resolveStall(decision: StallDecision) {
    return track('stall', () => sentryApi.resolveStall(decision));
  }

  function recoverRegion(regionId: string) {
    return track(`recover:${regionId}`, () => sentryApi.recoverRegion(regionId));
  }

  function startSentry() {
    return track('start', () => sentryApi.start());
  }

  /** Optimistic: the toggle flips at once and flips back if the sentry refuses. */
  async function setAutoFailover(enabled: boolean): Promise<void> {
    const before = state.value;
    if (before) {
      state.value = { ...before, autoFailoverEnabled: enabled };
    }
    try {
      await track('auto-failover', () => sentryApi.setAutoFailover(enabled));
    } catch (error) {
      if (before && state.value?.autoFailoverEnabled === enabled) {
        state.value = { ...state.value, autoFailoverEnabled: before.autoFailoverEnabled };
      }
      throw error;
    }
  }

  /** Optimistic: the alert shows as acknowledged at once, and reverts if the sentry refuses. */
  async function acknowledgeAlert(alertId: string, by: string): Promise<void> {
    const patch = (acknowledgedBy: string | null, acknowledgedAt: string | null) => {
      if (state.value) {
        state.value = {
          ...state.value,
          alerts: state.value.alerts.map((alert) =>
            alert.id === alertId ? { ...alert, acknowledgedBy, acknowledgedAt } : alert,
          ),
        };
      }
    };
    patch(by, new Date().toISOString());
    try {
      await track(`ack:${alertId}`, () => sentryApi.acknowledgeAlert(alertId));
    } catch (error) {
      patch(null, null);
      throw error;
    }
  }

  function isPending(key: string): boolean {
    return pending.value[key] === true;
  }

  return {
    state,
    connection,
    unavailableReason,
    lastUpdatedAt,
    isRunning,
    regions,
    activeRegion,
    standbyRegions,
    currentFailover,
    isFailoverInProgress,
    failovers,
    alerts,
    openAlerts,
    openCriticalAlerts,
    canTriggerFailover,
    isStalled,
    regionById,
    failoverById,
    applySnapshot,
    markUnavailable,
    setConnection,
    refresh,
    triggerFailover,
    abortFailover,
    resolveStall,
    recoverRegion,
    startSentry,
    setAutoFailover,
    acknowledgeAlert,
    isPending,
  };
});
