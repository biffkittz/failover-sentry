/** Client of the edge router: routing reads and signed writes, and probes of the service through the edge. */
import {
  EDGE_EPOCH_HEADER,
  EDGE_REGION_HEADER,
  EDGE_ROUTING_PATH,
  type EdgeProbeResult,
  type EdgeRouting,
  type EdgeRoutingObservation,
  type EdgeRoutingUpdate,
  REGIONAL_PATHS,
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
import { databaseSnapshotSchema } from './region-admin.js';

const routingSchema = z.object({
  mode: z.enum(['active', 'maintenance']),
  activeRegionId: z.string().nullable(),
  epoch: z.number().int().min(0),
  version: z.number().int().min(0).catch(0),
  failoverId: z.string().nullable(),
  updatedAt: z.string(),
});

const observationSchema = z.object({ routing: routingSchema.nullable(), colo: z.string() });
const writeSchema = z.object({ applied: z.boolean(), routing: routingSchema, colo: z.string() });
const staleSchema = z.object({
  error: z.literal('stale_epoch'),
  routing: routingSchema.nullable().optional(),
});

export type RoutingWriteResult =
  | { outcome: 'applied' | 'unchanged'; routing: EdgeRouting; colo: string }
  | { outcome: 'stale'; routing: EdgeRouting | null };

export class EdgeAdminClient {
  constructor(
    /** Where routing reads and writes go (the public host, or the workers.dev URL if Bot Fight Mode is on). */
    private readonly adminBaseUrl: string,
    /** The protected service's public URL, for probes through the edge. */
    private readonly publicBaseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getRouting(timeoutMs = 5_000): Promise<EdgeRoutingObservation> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.adminBaseUrl}${EDGE_ROUTING_PATH}`, {
        headers: { accept: 'application/json', 'user-agent': 'failover-sentry-worker' },
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
    } catch (error) {
      throw new RetryableHttpError(`edge unreachable: ${errorMessage(error)}`, null);
    }
    const { json, text } = await readJson<unknown>(response);
    if (!response.ok) {
      throw this.failure(response, text, 'edge routing read');
    }
    return observationSchema.parse(json);
  }

  async setRouting(update: EdgeRoutingUpdate): Promise<RoutingWriteResult> {
    let response: Response;
    try {
      response = await signedFetch({
        url: `${this.adminBaseUrl}${EDGE_ROUTING_PATH}`,
        method: 'PUT',
        body: update,
        secret: this.secret,
        timeoutMs: 10_000,
        headers: { 'user-agent': 'failover-sentry-worker' },
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      throw new RetryableHttpError(`edge unreachable: ${errorMessage(error)}`, null);
    }
    const { json, text } = await readJson<unknown>(response);
    if (response.status === 409) {
      const stale = staleSchema.safeParse(json);
      if (stale.success) {
        return { outcome: 'stale', routing: stale.data.routing ?? null };
      }
    }
    if (!response.ok) {
      throw this.failure(response, text, 'edge routing write');
    }
    const parsed = writeSchema.parse(json);
    return { outcome: parsed.applied ? 'applied' : 'unchanged', routing: parsed.routing, colo: parsed.colo };
  }

  /** One request through the edge, the way users reach the service. Never throws. */
  async probe(timeoutMs: number): Promise<EdgeProbeResult> {
    const started = performance.now();
    const base = {
      regionId: 'edge',
      at: new Date().toISOString(),
      reportedStatus: null,
      version: null,
      db: null,
      chaos: null,
      servedBy: null,
      epoch: null,
    };
    try {
      const response = await this.fetchImpl(`${this.publicBaseUrl}${REGIONAL_PATHS.health}`, {
        headers: { accept: 'application/json', 'user-agent': 'failover-sentry-stabilizer' },
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      const { json, text } = await readJson<{ status?: string; version?: string; db?: unknown }>(response);
      const latencyMs = Math.round(performance.now() - started);
      const servedBy = response.headers.get(EDGE_REGION_HEADER);
      const epochHeader = response.headers.get(EDGE_EPOCH_HEADER);
      const db = databaseSnapshotSchema.safeParse(json?.db);
      const reported =
        json?.status === 'ok' || json?.status === 'degraded' || json?.status === 'down' ? json.status : null;
      return {
        ...base,
        ok: response.ok && reported !== 'down',
        latencyMs,
        httpStatus: response.status,
        error: response.ok ? null : describeHttpFailure(response, text, 'probe through the edge'),
        reportedStatus: reported,
        version: typeof json?.version === 'string' ? json.version : null,
        db: db.success ? db.data : null,
        servedBy,
        epoch: epochHeader === null ? null : Number(epochHeader),
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

  private failure(response: Response, text: string, context: string): Error {
    const message = describeHttpFailure(response, text, context);
    return isRetryableStatus(response.status)
      ? new RetryableHttpError(message, response.status)
      : new NonRetryableHttpError(message, response.status);
  }
}
