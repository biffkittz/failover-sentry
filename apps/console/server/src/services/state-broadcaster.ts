/**
 * Fans the sentry's state out to every open console as Server-Sent Events. One poller queries the workflow while at
 * least one browser listens, and only changes are pushed, however many tabs are open.
 */
import type { SentryStateView } from '@failover-sentry/contracts';
import type { SentryGateway } from './sentry-gateway.js';

export type StreamEvent =
  | { type: 'state'; data: SentryStateView }
  | { type: 'unavailable'; data: { running: false; workflowId: string; reason: string } };

export type Subscriber = (event: StreamEvent) => void;

interface Logger {
  warn(object: Record<string, unknown>, message: string): void;
}

export class StateBroadcaster {
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastFingerprint: string | null = null;
  private lastEvent: StreamEvent | null = null;

  constructor(
    private readonly gateway: SentryGateway,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  /** Subscribes and returns the unsubscribe function. A new subscriber gets the latest event at once. */
  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.lastEvent) {
      subscriber(this.lastEvent);
    }
    if (!this.timer) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.intervalMs);
    }
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.lastFingerprint = null;
        this.lastEvent = null;
      }
    };
  }

  get size(): number {
    return this.subscribers.size;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.subscribers.clear();
  }

  /** One poll; public for tests. */
  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      let event: StreamEvent;
      try {
        const state = await this.gateway.getState();
        event = state
          ? { type: 'state', data: state }
          : {
              type: 'unavailable',
              data: {
                running: false,
                workflowId: this.gateway.workflowId,
                reason: 'The sentry workflow is not running',
              },
            };
      } catch (error) {
        event = {
          type: 'unavailable',
          data: { running: false, workflowId: this.gateway.workflowId, reason: (error as Error).message },
        };
        this.logger.warn({ err: (error as Error).message }, 'sentry state query failed');
      }
      const fingerprint = fingerprintOf(event);
      if (fingerprint !== this.lastFingerprint) {
        this.lastFingerprint = fingerprint;
        this.lastEvent = event;
        for (const subscriber of this.subscribers) {
          subscriber(event);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

/** Ignores fields that change on every query without meaning anything changed. */
function fingerprintOf(event: StreamEvent): string {
  if (event.type === 'state') {
    const { updatedAt: _updatedAt, historyLength: _historyLength, ...rest } = event.data;
    return `state:${JSON.stringify(rest)}`;
  }
  return `unavailable:${event.data.reason}`;
}
