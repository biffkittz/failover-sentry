import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/http';
import { sentryApi } from '@/api/sentry-api';
import { useSentryStore } from '@/stores/sentry';
import { failoverRun, sentryState } from '@/__tests__/fixtures';

describe('sentry store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('derives regions, the active region and whether a failover may start', () => {
    const store = useSentryStore();
    expect(store.canTriggerFailover).toBe(false);
    store.applySnapshot(sentryState());
    expect(store.activeRegion?.config.id).toBe('east');
    expect(store.standbyRegions.map((region) => region.config.id)).toEqual(['west']);
    expect(store.canTriggerFailover).toBe(true);
    store.applySnapshot(sentryState({ currentFailover: failoverRun() }));
    expect(store.isFailoverInProgress).toBe(true);
    expect(store.canTriggerFailover).toBe(false);
    expect(store.failoverById('fo-7')?.toRegionId).toBe('west');
  });

  it('marks the sentry unavailable until the next snapshot', () => {
    const store = useSentryStore();
    store.applySnapshot(sentryState());
    store.markUnavailable('The sentry workflow is not running');
    expect(store.isRunning).toBe(false);
    store.applySnapshot(sentryState());
    expect(store.isRunning).toBe(true);
  });

  it('toggles automatic failover optimistically and rolls back when the sentry refuses', async () => {
    const store = useSentryStore();
    store.applySnapshot(sentryState({ autoFailoverEnabled: true }));
    let reject!: (error: Error) => void;
    vi.spyOn(sentryApi, 'setAutoFailover').mockReturnValue(new Promise((_resolve, fail) => (reject = fail)));
    const pending = store.setAutoFailover(false);
    expect(store.state?.autoFailoverEnabled).toBe(false);
    expect(store.isPending('auto-failover')).toBe(true);
    reject(new ApiError(409, 'rejected', 'nope'));
    await expect(pending).rejects.toThrow('nope');
    expect(store.state?.autoFailoverEnabled).toBe(true);
    expect(store.isPending('auto-failover')).toBe(false);
  });

  it('acknowledges alerts optimistically', async () => {
    const store = useSentryStore();
    store.applySnapshot(
      sentryState({
        alerts: [
          {
            id: 'al-1',
            kind: 'REPLICATION_STALLED',
            severity: 'critical',
            title: 'Stalled',
            message: 'x',
            at: new Date().toISOString(),
            failoverId: null,
            regionId: null,
            delivery: 'sent',
            deliveryDetail: null,
            acknowledgedBy: null,
            acknowledgedAt: null,
          },
        ],
      }),
    );
    expect(store.openCriticalAlerts).toHaveLength(1);
    vi.spyOn(sentryApi, 'acknowledgeAlert').mockRejectedValue(
      new ApiError(409, 'rejected', 'already acknowledged'),
    );
    const pending = store.acknowledgeAlert('al-1', 'octocat');
    expect(store.openCriticalAlerts).toHaveLength(0);
    await expect(pending).rejects.toThrow('already acknowledged');
    expect(store.openCriticalAlerts).toHaveLength(1);
  });
});
