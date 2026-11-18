import { buildApp } from './app.js';
import { ChaosController } from './chaos.js';
import { loadConfig } from './config.js';
import { SimulatedDatabase } from './database.js';
import { HttpPeerClient } from './peer-client.js';
import { ReplicationAgent } from './replication-agent.js';
import { WebhookSender } from './webhook-sender.js';

const config = loadConfig();
const startedAt = new Date().toISOString();

const db = new SimulatedDatabase(config.REGION_ID, {
  writesPerSecond: config.WRITES_PER_SECOND,
  replicationBatch: config.REPLICATION_BATCH,
  contactTimeoutMs: Math.max(5_000, config.TICK_INTERVAL_MS * 5),
});
const chaos = new ChaosController();

const app = buildApp({
  regionId: config.REGION_ID,
  regionName: config.REGION_NAME ?? config.REGION_ID,
  version: config.APP_VERSION,
  startedAt,
  db,
  chaos,
  adminSecrets: config.ADMIN_SHARED_SECRET,
  logger: { level: config.LOG_LEVEL },
});

const webhook =
  config.WEBHOOK_URL && config.WEBHOOK_SECRET
    ? new WebhookSender({ url: config.WEBHOOK_URL, secret: config.WEBHOOK_SECRET }, app.log)
    : null;

const agent = new ReplicationAgent(
  db,
  chaos,
  new HttpPeerClient(config.ADMIN_SHARED_SECRET[0] ?? ''),
  webhook,
  {
    regionId: config.REGION_ID,
    peers: config.PEERS,
    plannedSwitchDelayMs: config.PLANNED_SWITCH_DELAY_SECONDS * 1000,
    forcedSwitchDelayMs: config.FORCED_SWITCH_DELAY_SECONDS * 1000,
    plannedPeerTimeoutMs: config.PLANNED_PEER_TIMEOUT_SECONDS * 1000,
    tickIntervalMs: config.TICK_INTERVAL_MS,
  },
  app.log,
);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await agent.stop();
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
agent.start();
app.log.info(
  { region: config.REGION_ID, peers: config.PEERS.map((peer) => peer.regionId), webhook: Boolean(webhook) },
  'regional workload started (database starts as a replica until the sentry promotes a primary)',
);
