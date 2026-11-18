import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AlertRecord, RegionConfig } from '@failover-sentry/contracts';
import { verifySignatureHeader } from '@failover-sentry/contracts/signing';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudflareEmailAlerter, meetsThreshold, renderAlertEmail } from '../../src/adapters/alerts.js';
import { parseContainerAppId } from '../../src/adapters/compute.js';
import { EdgeAdminClient } from '../../src/adapters/edge-admin.js';
import { NonRetryableHttpError, RetryableHttpError } from '../../src/adapters/http.js';
import { RegionAdminClient } from '../../src/adapters/region-admin.js';

const secret = 'adapter-test-secret-0123456789';

type Handler = (request: IncomingMessage & { body: string }, response: ServerResponse) => unknown;

let server: Server | undefined;

async function serve(handler: Handler): Promise<string> {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => void handler(Object.assign(request, { body }), response));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const db = { role: 'replica', epoch: 3, lsn: 10, appliedLsn: 10, lagSeconds: 0, promotion: null };

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function regionClient(baseUrl: string) {
  const region: RegionConfig = { id: 'east', displayName: 'East', provider: 'local', baseUrl };
  return new RegionAdminClient(new Map([['east', region]]), secret);
}

describe('RegionAdminClient', () => {
  it('parses a healthy probe and reports failures as data', async () => {
    let healthy = true;
    const baseUrl = await serve((_request, response) =>
      healthy
        ? json(response, 200, { regionId: 'east', status: 'degraded', version: '1.2.3', db, chaos: null })
        : json(response, 503, { error: 'down' }),
    );
    const client = regionClient(baseUrl);
    const probe = await client.probe('east', 2_000);
    expect(probe).toMatchObject({ ok: true, reportedStatus: 'degraded', version: '1.2.3', db: { epoch: 3 } });
    healthy = false;
    expect(await client.probe('east', 2_000)).toMatchObject({ ok: false, httpStatus: 503 });
  });

  it('reports an unreachable region as a failed probe, never an exception', async () => {
    const client = regionClient('http://127.0.0.1:9');
    const probe = await client.probe('east', 500);
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeTruthy();
  });

  it('signs admin orders over method, path and body', async () => {
    let verified: boolean | undefined;
    const baseUrl = await serve(async (request, response) => {
      const result = await verifySignatureHeader({
        secret,
        method: request.method ?? '',
        path: request.url ?? '',
        body: request.body,
        header: request.headers['x-sentry-signature'] as string,
      });
      verified = result.ok;
      json(response, 202, { accepted: true, promotionId: 'east-p1', db });
    });
    const result = await regionClient(baseUrl).promote('east', {
      failoverId: 'fo-1',
      epoch: 4,
      mode: 'planned',
    });
    expect(verified).toBe(true);
    expect(result).toEqual({ outcome: 'ok', db, promotionId: 'east-p1' });
  });

  it('maps fencing refusals to data and other failures to retryable or not', async () => {
    let status = 409;
    const baseUrl = await serve((_request, response) =>
      status === 409
        ? json(response, 409, { error: 'stale_epoch', currentEpoch: 9, message: 'stale' })
        : json(response, status, { error: 'nope' }),
    );
    const client = regionClient(baseUrl);
    expect(await client.demote('east', { failoverId: null, epoch: 2, reason: 'x' })).toEqual({
      outcome: 'stale-epoch',
      currentEpoch: 9,
    });
    status = 503;
    await expect(client.demote('east', { failoverId: null, epoch: 2, reason: 'x' })).rejects.toBeInstanceOf(
      RetryableHttpError,
    );
    status = 400;
    await expect(client.demote('east', { failoverId: null, epoch: 2, reason: 'x' })).rejects.toBeInstanceOf(
      NonRetryableHttpError,
    );
  });

  it('refuses regions outside its configuration', () => {
    expect(() => regionClient('http://x').region('mars')).toThrow(/Unknown region/);
  });
});

describe('EdgeAdminClient', () => {
  it('reads routing, writes it signed, and maps fencing refusals', async () => {
    const routing = {
      mode: 'active',
      activeRegionId: 'east',
      epoch: 2,
      version: 5,
      failoverId: null,
      updatedAt: 'now',
    };
    let stale = false;
    const baseUrl = await serve((request, response) => {
      if (request.method === 'GET') {
        json(response, 200, { routing, colo: 'IAD' });
      } else if (stale) {
        json(response, 409, { error: 'stale_epoch', routing });
      } else {
        const update = JSON.parse(request.body) as Record<string, unknown>;
        json(response, 200, {
          applied: true,
          routing: { ...routing, ...update, updatedAt: 'now' },
          colo: 'IAD',
        });
      }
    });
    const client = new EdgeAdminClient(baseUrl, baseUrl, secret);
    expect(await client.getRouting()).toEqual({ routing, colo: 'IAD' });
    const written = await client.setRouting({
      mode: 'active',
      activeRegionId: 'west',
      epoch: 3,
      version: 6,
      failoverId: 'fo-1',
    });
    expect(written).toMatchObject({ outcome: 'applied', routing: { activeRegionId: 'west', epoch: 3 } });
    stale = true;
    expect(
      await client.setRouting({
        mode: 'active',
        activeRegionId: 'west',
        epoch: 1,
        version: 1,
        failoverId: null,
      }),
    ).toEqual({
      outcome: 'stale',
      routing,
    });
  });

  it('labels probes through the edge with the serving region, and explains Cloudflare challenges', async () => {
    let challenged = false;
    const baseUrl = await serve((_request, response) =>
      challenged
        ? response
            .writeHead(403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' })
            .end('<html>challenge</html>')
        : json(
            response,
            200,
            { status: 'ok', version: '1', db },
            { 'x-sentry-region': 'west', 'x-sentry-epoch': '7' },
          ),
    );
    const client = new EdgeAdminClient(baseUrl, baseUrl, secret);
    expect(await client.probe(2_000)).toMatchObject({ ok: true, servedBy: 'west', epoch: 7 });
    challenged = true;
    const probe = await client.probe(2_000);
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/Cloudflare challenged the request/);
  });
});

describe('alerts', () => {
  const alert: AlertRecord = {
    id: 'al-1',
    kind: 'REPLICATION_STALLED',
    severity: 'critical',
    title: 'Replica sync stalled',
    message: 'west did not confirm',
    at: '2026-01-01T00:00:00.000Z',
    failoverId: 'fo-3',
    regionId: 'west',
    delivery: 'pending',
    deliveryDetail: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
  };

  it('renders an email with a link to the failover', () => {
    const email = renderAlertEmail(alert, {
      serviceName: 'storefront',
      consoleUrl: 'https://sentry.example.com',
    });
    expect(email.subject).toBe('[Failover Sentry · storefront] CRITICAL: Replica sync stalled');
    expect(email.text).toContain('https://sentry.example.com/failovers/fo-3');
  });

  it('filters by severity', () => {
    expect(meetsThreshold('critical', 'warning')).toBe(true);
    expect(meetsThreshold('info', 'warning')).toBe(false);
  });

  it('sends through Cloudflare Email Service with the documented payload', async () => {
    let received: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const baseUrl = await serve((request, response) => {
      received = {
        url: request.url,
        auth: request.headers.authorization,
        body: JSON.parse(request.body) as Record<string, unknown>,
      };
      json(response, 200, { success: true, result: { delivered: ['ops@example.com'] } });
    });
    const alerter = new CloudflareEmailAlerter({
      accountId: 'abc123',
      apiToken: 'token-xyz',
      from: 'sentry@example.com',
      fromName: 'Failover Sentry',
      to: ['ops@example.com'],
      endpoint: baseUrl,
    });
    await alerter.send(alert, { serviceName: 'storefront', consoleUrl: 'https://sentry.example.com' });
    expect(received.url).toBe('/accounts/abc123/email/sending/send');
    expect(received.auth).toBe('Bearer token-xyz');
    expect(received.body).toMatchObject({
      from: { address: 'sentry@example.com', name: 'Failover Sentry' },
      to: ['ops@example.com'],
      subject: expect.stringContaining('Replica sync stalled'),
    });
  });

  it('treats a refused send as non-retryable', async () => {
    const baseUrl = await serve((_request, response) =>
      json(response, 403, { success: false, errors: [{ code: 10000 }] }),
    );
    const alerter = new CloudflareEmailAlerter({
      accountId: 'abc',
      apiToken: 't',
      from: 'a@example.com',
      fromName: 'x',
      to: ['b@example.com'],
      endpoint: baseUrl,
    });
    await expect(alerter.send(alert, { serviceName: 's', consoleUrl: 'https://c' })).rejects.toBeInstanceOf(
      NonRetryableHttpError,
    );
  });
});

describe('compute', () => {
  it('parses Container App resource IDs', () => {
    expect(
      parseContainerAppId(
        '/subscriptions/sub/resourceGroups/rg-x/providers/Microsoft.App/containerApps/ca-east',
      ),
    ).toEqual({ subscriptionId: 'sub', resourceGroup: 'rg-x', name: 'ca-east' });
    expect(() => parseContainerAppId('/subscriptions/sub/resourceGroups/rg')).toThrow(/not a Container App/);
  });
});
