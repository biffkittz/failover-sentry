import { REGIONAL_PATHS, SIGNATURE_HEADER } from '@failover-sentry/contracts';
import { createSignatureHeader } from '@failover-sentry/contracts/signing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChaosController } from '../src/chaos.js';
import { SimulatedDatabase } from '../src/database.js';

const secret = 'regional-admin-secret-0123456789';

function setup() {
  const db = new SimulatedDatabase('east', {
    writesPerSecond: 0,
    replicationBatch: 10,
    contactTimeoutMs: 5_000,
  });
  const chaos = new ChaosController();
  const app = buildApp({
    regionId: 'east',
    regionName: 'East <US>',
    version: 'test',
    startedAt: '2026-01-01T00:00:00.000Z',
    db,
    chaos,
    adminSecrets: [secret],
    sleep: async () => undefined,
  });
  return { app, db, chaos };
}

async function signed(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    url,
    payload: payload || undefined,
    headers: {
      ...(payload ? { 'content-type': 'application/json' } : {}),
      [SIGNATURE_HEADER]: await createSignatureHeader({ secret, method, path: url, body: payload }),
    },
  };
}

let current: ReturnType<typeof setup> | undefined;
afterEach(async () => {
  await current?.app.close();
});

describe('regional workload HTTP API', () => {
  it('reports health with the database snapshot', async () => {
    current = setup();
    const response = await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.health });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      regionId: 'east',
      status: 'ok',
      db: { role: 'replica', epoch: 0 },
    });
  });

  it('escapes values on the storefront page', async () => {
    current = setup();
    const response = await current.app.inject({ method: 'GET', url: '/' });
    expect(response.body).toContain('East &lt;US&gt;');
    expect(response.body).not.toContain('East <US>');
  });

  it('rejects unsigned and wrongly signed admin requests', async () => {
    current = setup();
    const unsigned = await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.dbStatus });
    expect(unsigned.statusCode).toBe(401);
    const request = await signed('POST', REGIONAL_PATHS.promote, {
      failoverId: 'x',
      epoch: 1,
      mode: 'restore',
    });
    const tampered = await current.app.inject({
      ...request,
      payload: JSON.stringify({ failoverId: 'x', epoch: 99, mode: 'restore' }),
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('promotes, refuses stale epochs and demotes with signed orders', async () => {
    current = setup();
    const promote = await current.app.inject(
      await signed('POST', REGIONAL_PATHS.promote, { failoverId: 'boot', epoch: 2, mode: 'restore' }),
    );
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({ accepted: true, db: { role: 'primary', epoch: 2 } });

    const stale = await current.app.inject(
      await signed('POST', REGIONAL_PATHS.promote, { failoverId: 'old', epoch: 1, mode: 'planned' }),
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_epoch', currentEpoch: 2 });

    const planned = await current.app.inject(
      await signed('POST', REGIONAL_PATHS.demote, { failoverId: 'fo-1', epoch: 3, reason: 'fence' }),
    );
    expect(planned.statusCode).toBe(200);
    expect(planned.json()).toMatchObject({ demoted: true, db: { role: 'replica', epoch: 3 } });
  });

  it('validates admin request bodies', async () => {
    current = setup();
    const response = await current.app.inject(
      await signed('POST', REGIONAL_PATHS.promote, { failoverId: 'x', epoch: 'one', mode: 'restore' }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('goes down under chaos but can always be healed', async () => {
    current = setup();
    await current.app.inject(await signed('PUT', REGIONAL_PATHS.chaos, { health: 'down' }));
    expect((await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.health })).statusCode).toBe(503);
    expect((await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.liveness })).statusCode).toBe(200);
    const healed = await current.app.inject(await signed('PUT', REGIONAL_PATHS.chaos, { health: 'healthy' }));
    expect(healed.json()).toMatchObject({ health: 'healthy' });
    expect((await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.health })).statusCode).toBe(200);
  });

  it('reports degraded health under chaos', async () => {
    current = setup();
    await current.app.inject(
      await signed('PUT', REGIONAL_PATHS.chaos, { health: 'degraded', latencyMs: 10 }),
    );
    const health = await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.health });
    expect(health.json()).toMatchObject({ status: 'degraded', chaos: { latencyMs: 10 } });
  });

  it('simulates a power cycle: off serves 503, on boots an empty replica', async () => {
    current = setup();
    await current.app.inject(
      await signed('POST', REGIONAL_PATHS.promote, { failoverId: 'b', epoch: 4, mode: 'restore' }),
    );
    await current.app.inject(await signed('POST', REGIONAL_PATHS.power, { state: 'off' }));
    expect((await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.health })).statusCode).toBe(503);
    await current.app.inject(await signed('POST', REGIONAL_PATHS.power, { state: 'on' }));
    const health = await current.app.inject({ method: 'GET', url: REGIONAL_PATHS.health });
    expect(health.json()).toMatchObject({ db: { role: 'replica', epoch: 0 } });
  });
});
