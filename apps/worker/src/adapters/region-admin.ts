/**
 * Client of a regional workload: its public health endpoint (probes) and its signed admin API (database orders,
 * simulated power).
 */
import {
  REGIONAL_PATHS,
  type DatabaseSnapshot,
  type DemoteRequest,
  type ProbeResult,
  type PromoteRequest,
  type RegionConfig,
} from '@failover-sentry/contracts';
import { signedFetch } from '@failover-sentry/contracts/signing';
import { z } from 'zod';
import {
  describeHttpFailure,
  errorMessage,
  isRetryableStatus,
  NonRetryableHttpError,
  readJson,
  RetryableHttpError,
} from './http.js';

const promotionSchema = z.object({
  promotionId: z.string(),
  failoverId: z.string(),
  epoch: z.number(),
  mode: z.enum(['planned', 'forced', 'restore']),
  status: z.enum(['catching-up', 'switching', 'completed', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const databaseSnapshotSchema = z.object({
  role: z.enum(['primary', 'replica']),
  epoch: z.number().int().min(0),
  lsn: z.number().int().min(0),
  appliedLsn: z.number().int().min(0),
  lagSeconds: z.number().nullable(),
  promotion: promotionSchema.nullable(),
});

const healthSchema = z.object({
  regionId: z.string(),
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  db: databaseSnapshotSchema,
  chaos: z
    .object({
      health: z.enum(['healthy', 'degraded', 'down']),
      latencyMs: z.number(),
      errorRate: z.number(),
      replication: z.enum(['normal', 'slow', 'stalled', 'drop-webhook', 'fail']),
    })
    .nullable()
    .catch(null),
});

const orderResponseSchema = z.object({
  promotionId: z.string().optional(),
  db: databaseSnapshotSchema,
});

const staleEpochSchema = z.object({ error: z.literal('stale_epoch'), currentEpoch: z.number().int() });

export type OrderResult =
  | { outcome: 'ok'; db: DatabaseSnapshot; promotionId: string | null }
  | { outcome: 'stale-epoch'; currentEpoch: number };

export class RegionAdminClient {
  constructor(
    private readonly regions: ReadonlyMap<string, RegionConfig>,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  region(regionId: string): RegionConfig {
    const region = this.regions.get(regionId);
    if (!region) {
      throw new NonRetryableHttpError(
        `Unknown region "${regionId}" (not in the worker's configuration)`,
        400,
      );
    }
    return region;
  }

  /** One health probe. Never throws: failures are data (that is what a probe measures). */
  async probe(regionId: string, timeoutMs: number): Promise<ProbeResult> {
    const region = this.region(regionId);
    const started = performance.now();
    const at = new Date().toISOString();
    const base = { regionId, at, reportedStatus: null, version: null, db: null, chaos: null };
    try {
      const response = await this.fetchImpl(`${region.baseUrl}${REGIONAL_PATHS.health}`, {
        headers: { accept: 'application/json', 'user-agent': 'failover-sentry-monitor' },
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      const { json, text } = await readJson<unknown>(response);
      const latencyMs = Math.round(performance.now() - started);
      if (!response.ok) {
        return {
          ...base,
          ok: false,
          latencyMs,
          httpStatus: response.status,
          error: describeHttpFailure(response, text, 'health check'),
        };
      }
      const parsed = healthSchema.safeParse(json);
      if (!parsed.success) {
        return {
          ...base,
          ok: false,
          latencyMs,
          httpStatus: response.status,
          error: 'health response is malformed',
        };
      }
      return {
        ...base,
        ok: parsed.data.status !== 'down',
        latencyMs,
        httpStatus: response.status,
        error: null,
        reportedStatus: parsed.data.status,
        version: parsed.data.version,
        db: parsed.data.db,
        chaos: parsed.data.chaos,
      };
    } catch (error) {
      return {
        ...base,
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        httpStatus: null,
        error: errorMessage(error),
      };
    }
  }

  async getDatabaseStatus(regionId: string, timeoutMs = 5_000): Promise<DatabaseSnapshot> {
    const response = await this.send(regionId, 'GET', REGIONAL_PATHS.dbStatus, undefined, timeoutMs);
    const { json, text } = await readJson<unknown>(response);
    if (!response.ok) {
      throw this.failure(response, text, `database status of ${regionId}`);
    }
    return databaseSnapshotSchema.parse(json);
  }

  async promote(regionId: string, request: PromoteRequest): Promise<OrderResult> {
    return this.order(regionId, REGIONAL_PATHS.promote, request, `promotion of ${regionId}`);
  }

  async demote(regionId: string, request: DemoteRequest): Promise<OrderResult> {
    return this.order(regionId, REGIONAL_PATHS.demote, request, `demotion of ${regionId}`);
  }

  /** Simulated compute (local runs): power a region off (fencing) or on (a fresh boot). */
  async setPower(regionId: string, state: 'on' | 'off'): Promise<void> {
    const response = await this.send(regionId, 'POST', REGIONAL_PATHS.power, { state }, 10_000);
    if (!response.ok) {
      throw this.failure(response, await response.text(), `power ${state} of ${regionId}`);
    }
  }

  private async order(regionId: string, path: string, body: unknown, context: string): Promise<OrderResult> {
    const response = await this.send(regionId, 'POST', path, body, 10_000);
    const { json, text } = await readJson<unknown>(response);
    if (response.status === 409) {
      const stale = staleEpochSchema.safeParse(json);
      if (stale.success) {
        return { outcome: 'stale-epoch', currentEpoch: stale.data.currentEpoch };
      }
    }
    if (!response.ok) {
      throw this.failure(response, text, context);
    }
    const parsed = orderResponseSchema.parse(json);
    return { outcome: 'ok', db: parsed.db, promotionId: parsed.promotionId ?? null };
  }

  private async send(
    regionId: string,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const region = this.region(regionId);
    try {
      return await signedFetch({
        url: `${region.baseUrl}${path}`,
        method,
        body,
        secret: this.secret,
        timeoutMs,
        headers: { 'user-agent': 'failover-sentry-worker' },
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      throw new RetryableHttpError(`${regionId} unreachable: ${errorMessage(error)}`, null);
    }
  }

  private failure(response: Response, text: string, context: string): Error {
    const message = describeHttpFailure(response, text, context);
    return isRetryableStatus(response.status)
      ? new RetryableHttpError(message, response.status)
      : new NonRetryableHttpError(message, response.status);
  }
}
