/**
 * Talks to the other regions' databases: replicas poll the primary (simulated log shipping), and a node being
 * promoted in a planned failover fences the old primary.
 */
import { REGIONAL_PATHS, type DemoteRequest } from '@failover-sentry/contracts';
import { signedFetch } from '@failover-sentry/contracts/signing';
import { z } from 'zod';
import type { PeerDatabaseStatus } from './database.js';

export interface Peer {
  regionId: string;
  baseUrl: string;
}

export interface PeerClient {
  getStatus(peer: Peer): Promise<PeerDatabaseStatus>;
  demote(peer: Peer, request: DemoteRequest): Promise<void>;
}

const peerStatusSchema = z.object({
  role: z.enum(['primary', 'replica']),
  epoch: z.number().int().min(0),
  lsn: z.number().int().min(0),
});

export class HttpPeerClient implements PeerClient {
  constructor(
    private readonly secret: string,
    private readonly timeoutMs = 2_000,
  ) {}

  async getStatus(peer: Peer): Promise<PeerDatabaseStatus> {
    const response = await signedFetch({
      url: `${peer.baseUrl}${REGIONAL_PATHS.dbStatus}`,
      method: 'GET',
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    });
    if (!response.ok) {
      throw new Error(`peer ${peer.regionId} answered ${response.status}`);
    }
    const status = peerStatusSchema.parse(await response.json());
    return { regionId: peer.regionId, ...status };
  }

  async demote(peer: Peer, request: DemoteRequest): Promise<void> {
    const response = await signedFetch({
      url: `${peer.baseUrl}${REGIONAL_PATHS.demote}`,
      method: 'POST',
      body: request,
      secret: this.secret,
      timeoutMs: this.timeoutMs,
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`peer ${peer.regionId} refused demotion: ${response.status}`);
    }
  }
}
