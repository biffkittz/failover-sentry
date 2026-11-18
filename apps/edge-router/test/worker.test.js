// @ts-check
import { createSignatureHeader } from '@failover-sentry/contracts/signing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalKv } from '../src/local-kv.js';
import { compareOrder, handleRequest, ROUTING_PATH } from '../src/worker.js';

const secret = 'edge-admin-secret-0123456789abcdef';
const origins = { east: 'https://east.example.net', west: 'https://west.example.net' };

/** @param {{ delayMs?: number, now?: () => number }} [options] */
function setup(options = {}) {
  const kv = new LocalKv({
    visibilityDelayMs: options.delayMs ?? 0,
    ...(options.now ? { now: options.now } : {}),
  });
  /** @type {import('../src/worker.js').Env} */
  const env = {
    ROUTING: kv,
    ORIGINS: JSON.stringify(origins),
    ADMIN_SECRET: secret,
    SERVICE_NAME: 'storefront',
  };
  return { kv, env };
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} [signingSecret]
 */
async function putRouting(body, signingSecret = secret) {
  const payload = JSON.stringify(body);
  const signature = await createSignatureHeader({
    secret: signingSecret,
    method: 'PUT',
    path: ROUTING_PATH,
    body: payload,
  });
  return new Request(`https://dr.example.com${ROUTING_PATH}`, {
    method: 'PUT',
    body: payload,
    headers: { 'content-type': 'application/json', 'x-sentry-signature': signature },
  });
}

const active = (epoch = 1, version = 1, region = 'east') => ({
  mode: 'active',
  activeRegionId: region,
  epoch,
  version,
  failoverId: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('edge router', () => {
  it('reports no routing before the sentry writes one, and serves a holding page', async () => {
    const { env } = setup();
    const read = await handleRequest(new Request(`https://dr.example.com${ROUTING_PATH}`), env, {
      colo: 'IAD',
    });
    expect(await read.json()).toEqual({ routing: null, colo: 'IAD' });
    const page = await handleRequest(new Request('https://dr.example.com/'), env);
    expect(page.status).toBe(503);
    expect(page.headers.get('x-sentry-mode')).toBe('unassigned');
  });

  it('accepts writes signed with the contracts signing scheme and rejects others', async () => {
    const { env } = setup();
    const accepted = await handleRequest(await putRouting(active()), env, { colo: 'IAD' });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      applied: true,
      routing: { activeRegionId: 'east', epoch: 1 },
    });
    const forged = await handleRequest(await putRouting(active(9, 9), 'wrong-secret-0123456789'), env);
    expect(forged.status).toBe(401);
  });

  it('fences writes: older (epoch, version) is refused, equal is idempotent, newer wins', async () => {
    const { env } = setup();
    await handleRequest(await putRouting(active(5, 10)), env);
    const stale = await handleRequest(await putRouting(active(4, 99, 'west')), env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'stale_epoch', currentEpoch: 5 });
    const zombie = await handleRequest(await putRouting(active(5, 9, 'west')), env);
    expect(zombie.status).toBe(409);
    const repeat = await handleRequest(await putRouting(active(5, 10)), env);
    expect(await repeat.json()).toMatchObject({ applied: false });
    const newer = await handleRequest(await putRouting(active(5, 11, 'west')), env);
    expect(await newer.json()).toMatchObject({ applied: true, routing: { activeRegionId: 'west' } });
  });

  it('validates writes', async () => {
    const { env } = setup();
    const unknownRegion = await handleRequest(await putRouting(active(1, 1, 'mars')), env);
    expect(unknownRegion.status).toBe(400);
    const noRegion = await handleRequest(await putRouting({ ...active(), activeRegionId: null }), env);
    expect(noRegion.status).toBe(400);
  });

  it('proxies to the active region and labels the response', async () => {
    const { env } = setup();
    await handleRequest(await putRouting(active(3, 1, 'west')), env);
    const upstream = vi.fn(
      async (/** @type {URL} */ target) => new Response(`hello from ${target.host}`, { status: 200 }),
    );
    vi.stubGlobal('fetch', upstream);
    const response = await handleRequest(new Request('https://dr.example.com/healthz?x=1'), env);
    expect(await response.text()).toBe('hello from west.example.net');
    expect(response.headers.get('x-sentry-region')).toBe('west');
    expect(response.headers.get('x-sentry-epoch')).toBe('3');
    expect(String(upstream.mock.calls[0]?.[0])).toBe('https://west.example.net/healthz?x=1');
  });

  it('serves the holding page in maintenance and a 502 when the origin is unreachable', async () => {
    const { env } = setup();
    await handleRequest(await putRouting({ ...active(2, 1), mode: 'maintenance' }), env);
    const holding = await handleRequest(
      new Request('https://dr.example.com/', { headers: { accept: 'application/json' } }),
      env,
    );
    expect(holding.status).toBe(503);
    expect(holding.headers.get('retry-after')).toBe('15');
    await handleRequest(await putRouting(active(2, 2)), env);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))),
    );
    const unreachable = await handleRequest(new Request('https://dr.example.com/'), env);
    expect(unreachable.status).toBe(502);
  });

  it('serves the old routing until a write propagates', async () => {
    let now = Date.now();
    const { env } = setup({ delayMs: 5_000, now: () => now });
    await handleRequest(await putRouting(active(1, 1, 'east')), env, { now: () => now });
    now += 6_000;
    await handleRequest(await putRouting(active(2, 2, 'west')), env, { now: () => now });
    const read = async () =>
      /** @type {{ routing: { activeRegionId: string } }} */ (
        await (await handleRequest(new Request(`https://dr.example.com${ROUTING_PATH}`), env)).json()
      ).routing.activeRegionId;
    expect(await read()).toBe('east');
    now += 5_000;
    expect(await read()).toBe('west');
  });

  it('orders by epoch first, then version', () => {
    expect(compareOrder({ epoch: 2, version: 0 }, { epoch: 1, version: 50 })).toBe(1);
    expect(compareOrder({ epoch: 2, version: 3 }, { epoch: 2, version: 4 })).toBe(-1);
    expect(compareOrder({ epoch: 2, version: 4 }, { epoch: 2, version: 4 })).toBe(0);
  });
});
