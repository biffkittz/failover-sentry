import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useEventSource } from '@/composables/use-event-source';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  emit(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }

  close(): void {
    this.closed = true;
  }
}

describe('useEventSource', () => {
  it('dispatches named events as parsed JSON, reconnects with backoff and closes with its scope', async () => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    const received: number[] = [];
    const statuses: string[] = [];
    const scope = effectScope();
    scope.run(() =>
      useEventSource<{ tick: { n: number } }>('/stream', {
        handlers: { tick: (data) => received.push(data.n) },
        onStatusChange: (status) => statuses.push(status),
        createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      }),
    );
    const first = FakeEventSource.instances[0];
    first?.onopen?.();
    first?.emit('tick', { n: 1 });
    expect(received).toEqual([1]);

    first?.onerror?.();
    expect(first?.closed).toBe(true);
    expect(statuses).toContain('reconnecting');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    scope.stop();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
    expect(statuses.at(-1)).toBe('closed');
    vi.useRealTimers();
  });

  it('stops reconnecting when told to', async () => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    const scope = effectScope();
    scope.run(() =>
      useEventSource<{ tick: unknown }>('/stream', {
        handlers: {},
        shouldReconnect: () => false,
        createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      }),
    );
    FakeEventSource.instances[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    scope.stop();
    vi.useRealTimers();
  });
});
