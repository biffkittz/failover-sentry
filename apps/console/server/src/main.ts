/** Failover Sentry console: serves the Vue app and its API, and relays webhooks to the sentry. */
import { Client, Connection, type ConnectionOptions } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { buildApp } from './app.js';
import { HttpGitHubClient } from './auth/github.js';
import { loadConsoleConfig } from './config.js';
import { HttpChaosService } from './services/chaos-service.js';
import { TemporalSentryGateway } from './services/sentry-gateway.js';

const config = loadConsoleConfig();
const { connectionOptions, namespace = 'default' } = loadClientConnectConfig();
// Connects on first use, so the console starts (and serves its login page) even while Temporal is unreachable.
const connection = Connection.lazy(connectionOptions as ConnectionOptions);
const client = new Client({ connection, namespace });
const gateway = new TemporalSentryGateway(client, config.sentry, config.taskQueue);

const app = await buildApp({
  config,
  gateway,
  chaos: new HttpChaosService(config.sentry.regions, config.regionAdminSecret),
  github:
    config.auth.mode === 'github'
      ? new HttpGitHubClient(config.auth.clientId, config.auth.clientSecret)
      : null,
  logger: {
    level: config.logLevel,
    // Never log credentials: session cookies, OAuth codes, webhook signatures.
    redact: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-sentry-signature"]',
      'res.headers["set-cookie"]',
    ],
  },
});

if (config.auth.mode === 'github' && config.auth.allowedUsers.length === 0) {
  app.log.warn('GITHUB_ALLOWED_USERS is empty: nobody can sign in');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await connection.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });

// The worker normally starts the sentry; this makes the console self-sufficient too (idempotent).
void (async () => {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await gateway.ensureRunning();
      app.log.info({ workflowId: gateway.workflowId }, 'sentry workflow ensured');
      return;
    } catch (error) {
      app.log.warn({ attempt, err: (error as Error).message }, 'could not ensure the sentry workflow yet');
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * attempt)));
    }
  }
})();
