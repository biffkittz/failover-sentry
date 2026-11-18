/**
 * Delivers the replication webhook to the sentry's console (the "downstream confirmation" the failover waits for).
 *
 * Delivery is at-least-once: transient failures are retried with exponential backoff, and every attempt carries the
 * same event ID so the receiver can deduplicate. When every attempt fails the sentry's durable timeout takes over.
 */
import type { ReplicationWebhookEvent } from '@failover-sentry/contracts';
import { signedFetch } from '@failover-sentry/contracts/signing';
import type { Logger } from './logger.js';

export interface WebhookSenderOptions {
  url: string;
  secret: string;
  /** Delays between attempts; the number of entries is the number of retries. */
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export class WebhookSender {
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly options: WebhookSenderOptions,
    private readonly logger: Logger,
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Resolves true once the receiver accepted the event, false after the last failed attempt. */
  async send(event: ReplicationWebhookEvent): Promise<boolean> {
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        const response = await signedFetch({
          url: this.options.url,
          method: 'POST',
          body: event,
          secret: this.options.secret,
          timeoutMs: this.options.timeoutMs ?? 10_000,
          headers: { 'user-agent': 'failover-sentry-regional-app' },
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        });
        if (response.ok) {
          this.logger.info(
            { eventId: event.eventId, type: event.type, attempt },
            'replication webhook delivered',
          );
          return true;
        }
        // 4xx (other than 408/429) means the receiver will never accept this event; don't hammer it.
        const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
        this.logger.warn(
          { eventId: event.eventId, status: response.status, attempt, retryable },
          'replication webhook rejected',
        );
        if (!retryable) {
          return false;
        }
      } catch (error) {
        this.logger.warn(
          { eventId: event.eventId, attempt, err: (error as Error).message },
          'replication webhook failed',
        );
      }
      const delay = this.retryDelaysMs[attempt];
      if (delay === undefined) {
        break;
      }
      await this.sleep(delay);
    }
    this.logger.error(
      { eventId: event.eventId },
      'replication webhook undeliverable; the sentry will time out',
    );
    return false;
  }
}
