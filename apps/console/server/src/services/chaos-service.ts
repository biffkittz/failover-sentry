/**
 * The chaos panel's backend: reads and changes a region's chaos switches through its signed admin API. Chaos is
 * "the world" the sentry reacts to, so it goes straight to the region, not through the sentry.
 */
import {
  REGIONAL_PATHS,
  type ChaosSettings,
  type ChaosUpdate,
  type RegionConfig,
} from '@failover-sentry/contracts';
import { signedFetch } from '@failover-sentry/contracts/signing';
import { z } from 'zod';
import { GatewayError } from './sentry-gateway.js';

export const chaosUpdateSchema = z
  .object({
    health: z.enum(['healthy', 'degraded', 'down']),
    latencyMs: z.number().int().min(0).max(30_000),
    errorRate: z.number().min(0).max(1),
    replication: z.enum(['normal', 'slow', 'stalled', 'drop-webhook', 'fail']),
  })
  .partial()
  .strict();

const chaosSettingsSchema = z.object({
  health: z.enum(['healthy', 'degraded', 'down']),
  latencyMs: z.number(),
  errorRate: z.number(),
  replication: z.enum(['normal', 'slow', 'stalled', 'drop-webhook', 'fail']),
});

export interface ChaosService {
  get(regionId: string): Promise<ChaosSettings>;
  update(regionId: string, update: ChaosUpdate): Promise<ChaosSettings>;
}

export class HttpChaosService implements ChaosService {
  constructor(
    private readonly regions: readonly RegionConfig[],
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get(regionId: string): Promise<ChaosSettings> {
    return this.call(regionId, 'GET');
  }

  update(regionId: string, update: ChaosUpdate): Promise<ChaosSettings> {
    return this.call(regionId, 'PUT', chaosUpdateSchema.parse(update));
  }

  private async call(regionId: string, method: 'GET' | 'PUT', body?: ChaosUpdate): Promise<ChaosSettings> {
    const region = this.regions.find((candidate) => candidate.id === regionId);
    if (!region) {
      throw new GatewayError(404, 'unknown_region', `Unknown region "${regionId}"`);
    }
    let response: Response;
    try {
      response = await signedFetch({
        url: `${region.baseUrl}${REGIONAL_PATHS.chaos}`,
        method,
        body,
        secret: this.secret,
        timeoutMs: 8_000,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      throw new GatewayError(
        502,
        'region_unreachable',
        `${regionId} is unreachable: ${(error as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new GatewayError(502, 'region_error', `${regionId} answered HTTP ${response.status}`);
    }
    return chaosSettingsSchema.parse(await response.json());
  }
}
