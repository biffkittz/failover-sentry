/**
 * A typed EventSource with reconnection (exponential backoff with jitter, reset after a healthy connection) and
 * cleanup when the calling component unmounts.
 */
import { getCurrentScope, onScopeDispose, readonly, ref, type Ref } from 'vue';

export type EventSourceStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseEventSourceOptions<Events extends object> {
  /** One handler per named event; data arrives JSON-parsed. */
  handlers: { [Name in keyof Events]?: (data: Events[Name]) => void };
  onStatusChange?: (status: EventSourceStatus) => void;
  /** Called after an error, before reconnecting; return false to stop (e.g. the session ended). */
  shouldReconnect?: () => boolean | Promise<boolean>;
  maxBackoffMs?: number;
  createEventSource?: (url: string) => EventSource;
}

export interface UseEventSource {
  status: Readonly<Ref<EventSourceStatus>>;
  close: () => void;
}

export function useEventSource<Events extends object>(
  url: string,
  options: UseEventSourceOptions<Events>,
): UseEventSource {
  const status = ref<EventSourceStatus>('connecting');
  const create =
    options.createEventSource ?? ((target: string) => new EventSource(target, { withCredentials: true }));
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  let source: EventSource | null = null;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const setStatus = (next: EventSourceStatus) => {
    status.value = next;
    options.onStatusChange?.(next);
  };

  const connect = () => {
    if (closed) {
      return;
    }
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    source = create(url);
    source.onopen = () => {
      attempts = 0;
      setStatus('open');
    };
    for (const name of Object.keys(options.handlers) as Array<keyof Events & string>) {
      source.addEventListener(name, (event) => {
        const handler = options.handlers[name];
        try {
          handler?.(JSON.parse((event as MessageEvent<string>).data) as Events[typeof name]);
        } catch (error) {
          console.error(`Could not handle "${name}" event`, error);
        }
      });
    }
    source.onerror = () => {
      // Our own backoff replaces the browser's fixed retry, so a down server isn't hammered.
      source?.close();
      source = null;
      if (closed) {
        return;
      }
      attempts += 1;
      setStatus('reconnecting');
      const delay =
        Math.min(maxBackoffMs, 1_000 * 2 ** Math.min(attempts - 1, 5)) * (0.75 + Math.random() * 0.5);
      retryTimer = setTimeout(async () => {
        const proceed = options.shouldReconnect ? await options.shouldReconnect() : true;
        if (proceed) {
          connect();
        } else {
          close();
        }
      }, delay);
    };
  };

  const close = () => {
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    source?.close();
    source = null;
    setStatus('closed');
  };

  connect();
  if (getCurrentScope()) {
    onScopeDispose(close);
  }
  return { status: readonly(status), close };
}
