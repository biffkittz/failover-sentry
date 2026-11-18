/**
 * Assembles the console server: security headers (CSP), rate limits, CSRF defence, authentication, the API, the
 * webhook gateway and the Vue app's static files.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CSRF_HEADER } from '@failover-sentry/contracts';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { GitHubClient } from './auth/github.js';
import { authPlugin } from './auth/plugin.js';
import type { ConsoleConfig } from './config.js';
import { apiRoutes } from './routes/api.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { ChaosService } from './services/chaos-service.js';
import { GatewayError, type SentryGateway } from './services/sentry-gateway.js';
import { StateBroadcaster } from './services/state-broadcaster.js';

export interface AppDependencies {
  config: ConsoleConfig;
  gateway: SentryGateway;
  chaos: ChaosService;
  github: GitHubClient | null;
  broadcaster?: StateBroadcaster;
  logger?: FastifyServerOptions['logger'];
  serveStatic?: boolean;
  sseHeartbeatMs?: number;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const clientErrorSchema = z
  .object({
    message: z.string().max(2_000),
    source: z.string().max(200).optional(),
    route: z.string().max(500).optional(),
    stack: z.string().max(4_000).optional(),
  })
  .strict();

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    // The only way in is Cloudflare (through the tunnel's cloudflared): trust its forwarding headers.
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  const broadcaster =
    deps.broadcaster ?? new StateBroadcaster(deps.gateway, config.statePollIntervalMs, app.log);
  app.addHook('onClose', async () => broadcaster.stop());

  // Set before any plugin registers: Fastify hands the error handler down to child contexts as they are created.
  app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', message: z.prettifyError(error) });
    }
    if (error instanceof GatewayError) {
      if (error.status >= 500) {
        request.log.error({ err: error.message, code: error.code }, 'sentry gateway error');
      }
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'request_error', message: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong.' });
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://avatars.githubusercontent.com'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(config.production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    // GitHub avatars are cross-origin images without CORP headers.
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.production ? { maxAge: 31_536_000, includeSubDomains: false } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => (request.headers['cf-connecting-ip'] as string | undefined) ?? request.ip,
  });

  // CSRF: state-changing browser requests must carry the custom header (a cross-site form can't set it, and a
  // cross-origin fetch with it needs a CORS preflight this server never grants) and come from our own origin.
  app.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) {
      return undefined;
    }
    const path = request.url.split('?')[0] ?? '';
    if (path.startsWith('/api/webhooks/') || (!path.startsWith('/api/') && !path.startsWith('/auth/'))) {
      return undefined;
    }
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    const sameOrigin =
      (!origin || origin === config.publicUrl.origin) && (!site || site === 'same-origin' || site === 'none');
    if (request.headers[CSRF_HEADER] !== '1' || !sameOrigin) {
      return reply.code(403).send({ error: 'csrf', message: 'Cross-site request refused.' });
    }
    return undefined;
  });

  await app.register(authPlugin, { config, github: deps.github });

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await deps.gateway.ping();
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', reason: 'Temporal is unreachable' });
    }
  });

  await app.register(async (scope) =>
    webhookRoutes(scope, { gateway: deps.gateway, secrets: config.webhookSecrets }),
  );
  await app.register(async (scope) =>
    apiRoutes(scope, {
      gateway: deps.gateway,
      chaos: deps.chaos,
      broadcaster,
      ...(deps.sseHeartbeatMs ? { heartbeatMs: deps.sseHeartbeatMs } : {}),
    }),
  );

  // Errors the Vue app reports (global error handler): logged here, where Log Analytics collects them.
  app.post(
    '/api/client-errors',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = clientErrorSchema.safeParse(request.body);
      if (parsed.success) {
        request.log.warn(
          { clientError: parsed.data, user: request.user?.login ?? null },
          'client-side error',
        );
      }
      return reply.code(204).send();
    },
  );

  const serveStatic = deps.serveStatic ?? true;
  const indexHtml = join(config.webDistDir, 'index.html');
  if (serveStatic && existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
      setHeaders: (reply, path) => {
        // Vite fingerprints everything under /assets: cache forever. Everything else revalidates.
        reply.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  } else if (serveStatic) {
    app.log.warn({ webDistDir: config.webDistDir }, 'the Vue app is not built; only the API is served');
  }

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    if (
      request.method === 'GET' &&
      wantsHtml &&
      !path.startsWith('/api/') &&
      !path.startsWith('/auth/') &&
      serveStatic &&
      existsSync(indexHtml)
    ) {
      // Client-side routes (/failovers/fo-12, ...) all load the single-page app.
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });

  return app;
}
