/**
 * Failover Sentry worker: polls the task queue for the sentry's workflows and activities, and makes sure the sentry
 * itself is running.
 */
import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { DefaultLogger, NativeConnection, Runtime, type LogLevel } from '@temporalio/worker';
import { ensureSentry } from './bootstrap.js';
import { loadWorkerConfig } from './config.js';
import { startHealthServer } from './health-server.js';
import { createWorker } from './temporal-worker.js';

const config = loadWorkerConfig();

// JSON logs, one object per line, for Log Analytics.
Runtime.install({
  logger: new DefaultLogger(config.logLevel as LogLevel, (entry) => {
    console.log(
      JSON.stringify({
        time: new Date(Number(entry.timestampNanos / 1_000_000n)).toISOString(),
        level: entry.level.toLowerCase(),
        msg: entry.message,
        ...entry.meta,
      }),
    );
  }),
  shutdownSignals: ['SIGINT', 'SIGTERM'],
});

const { connectionOptions, namespace = 'default' } = loadClientConnectConfig();
const connection = await NativeConnection.connect(connectionOptions);
const worker = await createWorker(connection, namespace, config);

const health = startHealthServer(config.healthPort, () => {
  const state = worker.getState();
  return { ok: state === 'RUNNING', state };
});

const log = Runtime.instance().logger;
log.info('Failover Sentry worker starting', {
  namespace,
  taskQueue: config.taskQueue,
  regions: config.sentry.regions.map((region) => region.id),
  compute: config.computeProvider,
  alerts: config.alerts.provider,
});

if (config.bootstrapSentry) {
  // In the background: the worker must already be polling for the sentry's first workflow task.
  void (async () => {
    const clientConnection = await Connection.connect(connectionOptions);
    try {
      const client = new Client({ connection: clientConnection, namespace });
      const result = await ensureSentry(client, config.sentry, config.taskQueue);
      log.info('Sentry workflow ensured', { ...result });
    } catch (error) {
      log.error('Could not ensure the sentry workflow', { error: (error as Error).message });
    } finally {
      await clientConnection.close();
    }
  })();
}

try {
  await worker.run();
} finally {
  health.close();
  await connection.close();
}
