/**
 * The webhook gateway: external systems confirm asynchronous work here, and the gateway turns each confirmation
 * into a signal to the sentry. Today: a region's database reports that its promotion completed (or failed).
 *
 * Requests are authenticated by an HMAC signature over the raw body (no session, no CSRF header: the callers are
 * servers). Delivery is at-least-once, so the sentry deduplicates by event ID; the gateway answers 202 once Temporal
 * has durably accepted the signal, and 5xx when it couldn't, so the sender retries.
 */
import { REPLICATION_WEBHOOK_PATH, SIGNATURE_HEADER } from '@failover-sentry/contracts';
import { replicationWebhookEventSchema } from '@failover-sentry/contracts/schemas';
import { verifySignatureHeader } from '@failover-sentry/contracts/signing';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SentryGateway } from '../services/sentry-gateway.js';

export interface WebhookDependencies {
  gateway: SentryGateway;
  secrets: readonly string[];
}

export async function webhookRoutes(app: FastifyInstance, deps: WebhookDependencies): Promise<void> {
  // The signature covers the exact bytes sent, so this scope keeps the body as a string.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(
    REPLICATION_WEBHOOK_PATH,
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const rawBody = typeof request.body === 'string' ? request.body : '';
      const verified = await verifySignatureHeader({
        secret: deps.secrets,
        method: request.method,
        path: request.url,
        body: rawBody,
        header: request.headers[SIGNATURE_HEADER] as string | undefined,
      });
      if (!verified.ok) {
        request.log.warn({ reason: verified.reason }, 'rejected replication webhook');
        return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or missing signature.' });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return reply.code(400).send({ error: 'invalid_request', message: 'Body is not JSON.' });
      }
      const event = replicationWebhookEventSchema.safeParse(parsed);
      if (!event.success) {
        return reply.code(400).send({ error: 'invalid_request', message: z.prettifyError(event.error) });
      }
      await deps.gateway.signalReplicationComplete({ ...event.data, receivedAt: new Date().toISOString() });
      request.log.info(
        { eventId: event.data.eventId, type: event.data.type, failoverId: event.data.failoverId },
        'replication webhook relayed to the sentry',
      );
      return reply.code(202).send({ accepted: true, eventId: event.data.eventId });
    },
  );
}
