import type { DemoteRequest, ReplicationWebhookEvent } from '@failover-sentry/contracts';
import { describe, expect, it } from 'vitest';
import { ChaosController } from '../src/chaos.js';
import { SimulatedDatabase, type PeerDatabaseStatus } from '../src/database.js';
import { silentLogger, type Logger } from '../src/logger.js';
import type { Peer, PeerClient } from '../src/peer-client.js';
import { ReplicationAgent } from '../src/replication-agent.js';
import type { WebhookSender } from '../src/webhook-sender.js';

const west: Peer = { regionId: 'west', baseUrl: 'http://west' };

class FakePeer implements PeerClient {
  status: PeerDatabaseStatus = { regionId: 'west', role: 'primary', epoch: 1, lsn: 200 };
  reachable = true;
  demotions: DemoteRequest[] = [];

  async getStatus(): Promise<PeerDatabaseStatus> {
    if (!this.reachable) {
      throw new Error('unreachable');
    }
    return { ...this.status };
  }

  async demote(_peer: Peer, request: DemoteRequest): Promise<void> {
    this.demotions.push(request);
    this.status = { ...this.status, role: 'replica', epoch: request.epoch };
  }
}

function setup(logger: Logger = silentLogger) {
  const clock = { now: 0 };
  const db = new SimulatedDatabase(
    'east',
    { writesPerSecond: 0, replicationBatch: 50, contactTimeoutMs: 5_000 },
    () => clock.now,
  );
  const chaos = new ChaosController();
  const peer = new FakePeer();
  const sent: ReplicationWebhookEvent[] = [];
  const webhook = {
    send: async (event: ReplicationWebhookEvent) => (sent.push(event), true),
  } as WebhookSender;
  const agent = new ReplicationAgent(
    db,
    chaos,
    peer,
    webhook,
    {
      regionId: 'east',
      peers: [west],
      plannedSwitchDelayMs: 2_000,
      forcedSwitchDelayMs: 1_000,
      plannedPeerTimeoutMs: 10_000,
      tickIntervalMs: 500,
    },
    logger,
  );
  const step = async (ms: number, times = 1) => {
    for (let index = 0; index < times; index += 1) {
      clock.now += ms;
      await agent.tick();
    }
    await agent.flushWebhooks();
  };
  return { db, chaos, peer, sent, agent, step };
}

describe('ReplicationAgent', () => {
  it('replicates from the primary peer', async () => {
    const { db, step } = setup();
    await step(500, 4);
    expect(db.snapshot()).toMatchObject({ role: 'replica', epoch: 1, appliedLsn: 200, lagSeconds: 0 });
  });

  it('runs a planned promotion: fences the old primary, catches up, switches, then sends the webhook', async () => {
    const { db, peer, sent, step } = setup();
    await step(500); // appliedLsn 50 of 200
    db.promote({ failoverId: 'fo-9', epoch: 2, mode: 'planned' }, null);
    await step(500); // fences the old primary
    expect(peer.demotions).toEqual([{ epoch: 2, failoverId: 'fo-9', reason: 'planned promotion of east' }]);
    await step(500, 4); // catches up to 200, starts the 2 s switch
    expect(db.snapshot().promotion?.status).toBe('switching');
    expect(sent).toHaveLength(0);
    await step(1_000, 2);
    expect(db.snapshot()).toMatchObject({ role: 'primary', epoch: 2, appliedLsn: 200 });
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'replication.promotion.completed',
        failoverId: 'fo-9',
        epoch: 2,
        regionId: 'east',
        dataLossTransactions: 0,
      }),
    ]);
  });

  it('runs a forced promotion without the old primary, accounting for lost transactions', async () => {
    const { db, peer, sent, step } = setup();
    await step(500); // appliedLsn 50 of 200
    peer.reachable = false;
    db.promote({ failoverId: 'fo-3', epoch: 2, mode: 'forced' }, null);
    await step(600, 2);
    expect(db.snapshot()).toMatchObject({ role: 'primary', epoch: 2 });
    expect(sent[0]).toMatchObject({ type: 'replication.promotion.completed', dataLossTransactions: 150 });
  });

  it('never finishes while replication is stalled, and drops the webhook when told to', async () => {
    const { db, chaos, peer, sent, step } = setup();
    peer.reachable = false;
    chaos.update({ replication: 'stalled' });
    db.promote({ failoverId: 'fo-4', epoch: 2, mode: 'forced' }, null);
    await step(1_000, 10);
    expect(db.snapshot().role).toBe('replica');
    chaos.update({ replication: 'drop-webhook' });
    await step(1_000, 2);
    expect(db.snapshot().role).toBe('primary');
    expect(sent).toHaveLength(0);
  });

  it('fails a planned promotion when the primary stays unreachable, and reports the failure', async () => {
    const { db, peer, sent, step } = setup();
    peer.reachable = false;
    db.promote({ failoverId: 'fo-5', epoch: 2, mode: 'planned' }, null);
    await step(5_000, 3);
    expect(db.snapshot().promotion).toMatchObject({ status: 'failed' });
    expect(sent[0]).toMatchObject({ type: 'replication.promotion.failed', failoverId: 'fo-5' });
    // The reason reaches the sentry (and the operator), not just "unreachable".
    expect(sent[0]?.error).toContain('west: unreachable');
  });

  it('logs a peer becoming unreachable once, and again when it is back', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      info: (fields, message) => lines.push(`info ${message} ${JSON.stringify(fields)}`),
      warn: (fields, message) => lines.push(`warn ${message} ${JSON.stringify(fields)}`),
      error: (fields, message) => lines.push(`error ${message} ${JSON.stringify(fields)}`),
    };
    const { peer, step } = setup(logger);
    peer.reachable = false;
    await step(500, 4);
    peer.reachable = true;
    await step(500, 2);
    const peerLines = lines.filter((line) => line.includes('peer '));
    expect(peerLines).toEqual([
      'warn peer unreachable {"peer":"west","err":"unreachable"}',
      'info peer reachable again {"peer":"west"}',
    ]);
  });

  it('reports how long ago the replica last heard from a primary', async () => {
    const { db, peer, step } = setup();
    expect(db.snapshot().primaryContactAgeSeconds).toBeNull();
    await step(500);
    expect(db.snapshot().primaryContactAgeSeconds).toBe(0);
    peer.reachable = false;
    await step(500, 6);
    expect(db.snapshot().primaryContactAgeSeconds).toBe(3);
  });

  it('does nothing while the region is down', async () => {
    const { db, chaos, step } = setup();
    chaos.update({ health: 'down' });
    await step(500, 3);
    expect(db.snapshot().appliedLsn).toBe(0);
  });
});
