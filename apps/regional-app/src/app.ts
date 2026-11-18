/**
 * HTTP surface of a regional workload:
 * - Public: the storefront page, `/healthz` (what the sentry probes) and `/api/whoami`.
 * - Admin (`/internal/*`, HMAC-signed): database status, promote, demote, chaos and simulated power.
 */
import {
  REGIONAL_PATHS,
  SIGNATURE_HEADER,
  type DemoteResponse,
  type PromoteResponse,
  type RegionalHealthResponse,
  type StaleEpochError,
} from '@failover-sentry/contracts';
import { verifySignatureHeader } from '@failover-sentry/contracts/signing';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { z } from 'zod';
import { chaosUpdateSchema, type ChaosController } from './chaos.js';
import type { SimulatedDatabase } from './database.js';
import { renderStorefront } from './storefront.js';

export interface AppDependencies {
  regionId: string;
  regionName: string;
  version: string;
  startedAt: string;
  db: SimulatedDatabase;
  chaos: ChaosController;
  /** HMAC secrets accepted on the admin API (several during a rotation). */
  adminSecrets: readonly string[];
  logger?: FastifyServerOptions['logger'];
  sleep?: (ms: number) => Promise<void>;
}

const promoteSchema = z
  .object({
    failoverId: z.string().min(1).max(100),
    epoch: z.number().int().min(1),
    mode: z.enum(['planned', 'forced', 'restore']),
  })
  .strict();

const demoteSchema = z
  .object({
    failoverId: z.string().min(1).max(100).nullable(),
    epoch: z.number().int().min(0),
    reason: z.string().max(300),
  })
  .strict();

const powerSchema = z.object({ state: z.enum(['on', 'off']) }).strict();

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: string;
  }
}

/** Paths that always answer, so an operator can heal a region that chaos took down. */
const CHAOS_EXEMPT = new Set<string>([REGIONAL_PATHS.chaos, REGIONAL_PATHS.power, REGIONAL_PATHS.liveness]);

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    disableRequestLogging: true,
    bodyLimit: 16 * 1024,
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Keep the raw body: signatures cover the exact bytes that were sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    if (!body) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string) as unknown);
    } catch {
      const error = new Error('Request body is not valid JSON') as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });
  app.decorateRequest('rawBody', '');

  // Chaos: power, outage, latency and error injection, applied before any route runs.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (CHAOS_EXEMPT.has(path)) {
      return;
    }
    if (!deps.chaos.poweredOn) {
      return reply.code(503).send({ error: 'powered_off', message: 'This region is stopped.' });
    }
    const chaos = deps.chaos.get();
    if (chaos.latencyMs > 0) {
      await sleep(chaos.latencyMs);
    }
    if (chaos.health === 'down') {
      return reply.code(503).send({ error: 'down', message: 'This region is down (chaos).' });
    }
    if (deps.chaos.shouldFailRequest()) {
      return reply.code(500).send({ error: 'injected_error', message: 'Injected failure (chaos).' });
    }
    return undefined;
  });

  // Admin API: every request must carry a valid signature over method, path and body.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/internal/')) {
      return undefined;
    }
    const result = await verifySignatureHeader({
      secret: deps.adminSecrets,
      method: request.method,
      path: request.url,
      body: request.rawBody,
      header: request.headers[SIGNATURE_HEADER] as string | undefined,
    });
    if (!result.ok) {
      request.log.warn({ reason: result.reason, url: request.url }, 'rejected unsigned admin request');
      return reply
        .code(401)
        .send({ error: 'unauthorized', message: 'Invalid or missing request signature.' });
    }
    return undefined;
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', message: z.prettifyError(error) });
    }
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    return reply
      .code(status)
      .send({ error: 'error', message: status === 500 ? 'Internal error' : error.message });
  });

  const healthBody = (): RegionalHealthResponse => {
    const chaos = deps.chaos.get();
    return {
      regionId: deps.regionId,
      status: chaos.health === 'degraded' ? 'degraded' : 'ok',
      version: deps.version,
      startedAt: deps.startedAt,
      db: deps.db.snapshot(),
      chaos,
    };
  };

  // For the container platform's probes: the process is alive. Exempt from chaos, so a region taken "down" stays
  // down instead of being restarted (which would clear the chaos and wipe the in-memory database).
  app.get(REGIONAL_PATHS.liveness, async () => ({ status: 'alive' }));

  app.get(REGIONAL_PATHS.health, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return healthBody();
  });

  app.get('/', async (_request, reply) => {
    reply.header('cache-control', 'no-store').type('text/html; charset=utf-8');
    return renderStorefront({ regionName: deps.regionName, health: healthBody() });
  });

  app.get('/api/whoami', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const { regionId, db } = healthBody();
    return {
      regionId,
      regionName: deps.regionName,
      dbRole: db.role,
      epoch: db.epoch,
      servedAt: new Date().toISOString(),
    };
  });

  app.get(REGIONAL_PATHS.dbStatus, async () => deps.db.snapshot());

  app.post(REGIONAL_PATHS.promote, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = promoteSchema.parse(request.body);
    const result = deps.db.promote(body, null);
    if (result.kind === 'stale-epoch') {
      return reply.code(409).send(staleEpoch(result.currentEpoch, body.epoch));
    }
    request.log.info({ ...body, outcome: result.kind }, 'promotion order');
    const response: PromoteResponse = {
      accepted: true,
      promotionId: result.promotion.promotionId,
      db: deps.db.snapshot(),
    };
    return reply.code(result.kind === 'completed' ? 200 : 202).send(response);
  });

  app.post(REGIONAL_PATHS.demote, async (request, reply) => {
    const body = demoteSchema.parse(request.body);
    const result = deps.db.demote(body);
    if (result.kind === 'stale-epoch') {
      return reply.code(409).send(staleEpoch(result.currentEpoch, body.epoch));
    }
    request.log.info({ ...body, changed: result.changed }, 'demotion order');
    const response: DemoteResponse = { demoted: true, db: deps.db.snapshot() };
    return response;
  });

  app.get(REGIONAL_PATHS.chaos, async () => deps.chaos.get());

  app.put(REGIONAL_PATHS.chaos, async (request) => {
    const update = chaosUpdateSchema.parse(request.body ?? {});
    const settings = deps.chaos.update(update);
    request.log.warn({ settings }, 'chaos settings changed');
    return settings;
  });

  app.post(REGIONAL_PATHS.power, async (request) => {
    const { state } = powerSchema.parse(request.body);
    if (state === 'off' && deps.chaos.poweredOn) {
      deps.chaos.setPower(false);
    } else if (state === 'on' && !deps.chaos.poweredOn) {
      // A fresh boot: chaos is cleared and the in-memory database restarts empty, as a replica.
      deps.chaos.reset();
      deps.db.reset();
      deps.chaos.setPower(true);
    }
    return { power: deps.chaos.poweredOn ? 'on' : 'off' };
  });

  return app;
}

function staleEpoch(currentEpoch: number, requestedEpoch: number): StaleEpochError {
  return {
    error: 'stale_epoch',
    currentEpoch,
    message: `Order carries epoch ${requestedEpoch}, but this node already holds epoch ${currentEpoch}.`,
  };
}
