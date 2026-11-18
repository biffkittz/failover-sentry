import type { SentryStateView } from '@failover-sentry/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { SentryGateway } from '../src/services/sentry-gateway.js';
import { StateBroadcaster, type StreamEvent } from '../src/services/state-broadcaster.js';

const logger = { warn: vi.fn() };

function gatewayReturning(...states: Array<Partial<SentryStateView> | null | Error>) {
  const getState = vi.fn(async () => {
    const next = states.length > 1 ? states.shift() : states[0];
    if (next instanceof Error) {
      throw next;
    }
    return next as SentryStateView | null;
  });
  return { workflowId: 'wf', getState } as unknown as SentryGateway & { getState: typeof getState };
}

describe('StateBroadcaster', () => {
  it('pushes only changes, ignoring fields that change on every query', async () => {
    const gateway = gatewayReturning(
      { epoch: 1, updatedAt: 'a', historyLength: 10 },
      { epoch: 1, updatedAt: 'b', historyLength: 11 },
      { epoch: 2, updatedAt: 'c', historyLength: 12 },
    );
    const broadcaster = new StateBroadcaster(gateway, 60_000, logger);
    const events: StreamEvent[] = [];
    const unsubscribe = broadcaster.subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await broadcaster.poll();
    await broadcaster.poll();
    expect(events.map((event) => event.type === 'state' && event.data.epoch)).toEqual([1, 2]);
    unsubscribe();
    expect(broadcaster.size).toBe(0);
  });

  it('reports an unavailable sentry, and replays the latest event to new subscribers', async () => {
    const gateway = gatewayReturning(null);
    const broadcaster = new StateBroadcaster(gateway, 60_000, logger);
    const first: StreamEvent[] = [];
    broadcaster.subscribe((event) => first.push(event));
    await vi.waitFor(() => expect(first).toHaveLength(1));
    expect(first[0]).toMatchObject({ type: 'unavailable', data: { running: false } });
    const second: StreamEvent[] = [];
    broadcaster.subscribe((event) => second.push(event));
    expect(second).toHaveLength(1);
    broadcaster.stop();
  });

  it('turns query failures into unavailable events', async () => {
    const gateway = gatewayReturning(new Error('connection refused'));
    const broadcaster = new StateBroadcaster(gateway, 60_000, logger);
    const events: StreamEvent[] = [];
    broadcaster.subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'unavailable', data: { reason: 'connection refused' } });
    broadcaster.stop();
  });
});
