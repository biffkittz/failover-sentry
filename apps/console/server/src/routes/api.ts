/**
 * The console's JSON API. Every route needs a signed-in user; every state-changing route also needs the CSRF
 * header (checked globally in app.ts). Operator actions become Temporal Updates carrying the user's GitHub login,
 * so the sentry's history records who did what.
 */
import { chaosUpdateSchema, regionIdSchema } from '@failover-sentry/contracts/schemas';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChaosService } from '../services/chaos-service.js';
import type { SentryGateway } from '../services/sentry-gateway.js';
import type { StateBroadcaster, StreamEvent } from '../services/state-broadcaster.js';

const regionParams = z.object({ regionId: regionIdSchema });
const alertParams = z.object({ alertId: z.string().min(1).max(64) });

const failoverBody = z
  .object({
    targetRegionId: regionIdSchema.optional(),
    mode: z.enum(['planned', 'forced']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const abortBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const stallBody = z.object({ decision: z.enum(['keep-waiting', 'retry-forced', 'abort']) }).strict();
const autoFailoverBody = z.object({ enabled: z.boolean() }).strict();

export interface ApiDependencies {
  gateway: SentryGateway;
  chaos: ChaosService;
  broadcaster: StateBroadcaster;
  heartbeatMs?: number;
}

export async function apiRoutes(app: FastifyInstance, deps: ApiDependencies): Promise<void> {
  const { gateway, chaos, broadcaster } = deps;
  app.addHook('preHandler', app.requireUser);

  const actor = (request: FastifyRequest): string => request.user?.login ?? 'unknown';

  app.get('/api/sentry', async (_request, reply) => {
    const state = await gateway.getState();
    if (!state) {
      return reply.code(404).send({
        running: false,
        workflowId: gateway.workflowId,
        reason: 'The sentry workflow is not running',
      });
    }
    return state;
  });

  app.post('/api/sentry/start', async (_request, reply) => {
    await gateway.ensureRunning();
    return reply.code(202).send({ workflowId: gateway.workflowId });
  });

  app.get('/api/sentry/stream', (request, reply) =>
    streamState(request, reply, broadcaster, deps.heartbeatMs ?? 15_000),
  );

  app.post('/api/sentry/failover', async (request, reply) => {
    const body = failoverBody.parse(request.body);
    const accepted = await gateway.triggerFailover({ ...body, requestedBy: actor(request) });
    return reply.code(202).send(accepted);
  });

  app.post('/api/sentry/failover/abort', async (request, reply) => {
    const body = abortBody.parse(request.body);
    return reply.code(202).send(await gateway.abortFailover({ ...body, requestedBy: actor(request) }));
  });

  app.post('/api/sentry/failover/stall', async (request) => {
    const body = stallBody.parse(request.body);
    return gateway.resolveStall({ ...body, requestedBy: actor(request) });
  });

  app.put('/api/sentry/auto-failover', async (request) => {
    const body = autoFailoverBody.parse(request.body);
    return gateway.setAutoFailover({ ...body, requestedBy: actor(request) });
  });

  app.post('/api/sentry/alerts/:alertId/acknowledge', async (request) => {
    const { alertId } = alertParams.parse(request.params);
    return gateway.acknowledgeAlert({ alertId, requestedBy: actor(request) });
  });

  app.post('/api/regions/:regionId/recover', async (request, reply) => {
    const { regionId } = regionParams.parse(request.params);
    return reply.code(202).send(await gateway.recoverRegion({ regionId, requestedBy: actor(request) }));
  });

  app.get('/api/regions/:regionId/monitor', async (request) => {
    const { regionId } = regionParams.parse(request.params);
    return gateway.getMonitor(regionId);
  });

  app.get('/api/regions/:regionId/chaos', async (request) => {
    const { regionId } = regionParams.parse(request.params);
    return chaos.get(regionId);
  });

  app.put('/api/regions/:regionId/chaos', async (request) => {
    const { regionId } = regionParams.parse(request.params);
    const update = chaosUpdateSchema.parse(request.body);
    const settings = await chaos.update(regionId, update);
    request.log.warn({ regionId, update, by: actor(request) }, 'chaos settings changed');
    return settings;
  });
}

/** Server-Sent Events: the latest state at once, then every change; comments as heartbeats keep proxies open. */
function streamState(
  request: FastifyRequest,
  reply: FastifyReply,
  broadcaster: StateBroadcaster,
  heartbeatMs: number,
): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Tells buffering proxies (nginx-style) to pass events through immediately.
    'x-accel-buffering': 'no',
  });
  raw.write('retry: 3000\n\n');
  const send = (event: StreamEvent) => {
    raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  const unsubscribe = broadcaster.subscribe(send);
  const heartbeat = setInterval(() => raw.write(': ping\n\n'), heartbeatMs);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
