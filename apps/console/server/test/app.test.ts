import type { AddressInfo } from 'node:net';
import { createSignatureHeader } from '@failover-sentry/contracts/signing';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayError } from '../src/services/sentry-gateway.js';
import { cookieHeader, csrf, fakeGateway, fakeGitHub, PUBLIC_URL, testApp, testConfig } from './helpers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function signIn(instance: FastifyInstance): Promise<string> {
  const login = await instance.inject({ method: 'GET', url: '/auth/github/login?returnTo=/failovers' });
  const oauthCookie = cookieHeader(login.headers['set-cookie']);
  const state = new URL(String(login.headers.location)).searchParams.get('state');
  const callback = await instance.inject({
    method: 'GET',
    url: `/auth/github/callback?code=abc&state=${state}`,
    headers: { cookie: oauthCookie },
  });
  expect(callback.statusCode).toBe(302);
  return cookieHeader(callback.headers['set-cookie']);
}

describe('authentication', () => {
  it('starts the GitHub flow with state, PKCE and a sealed state cookie', async () => {
    ({ app } = await testApp());
    const response = await app.inject({ method: 'GET', url: '/auth/github/login' });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.origin).toBe('https://github.com');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/github/callback`);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('__Host-sentry_oauth=');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('signs in an allowlisted user, revokes the GitHub token and returns to the requested page', async () => {
    const github = fakeGitHub();
    ({ app } = await testApp({ github }));
    const login = await app.inject({ method: 'GET', url: '/auth/github/login?returnTo=/failovers' });
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=abc&state=${state}`,
      headers: { cookie: cookieHeader(login.headers['set-cookie']) },
    });
    expect(callback.headers.location).toBe('/failovers');
    expect(github.revokeToken).toHaveBeenCalledWith('gho_token');
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookieHeader(callback.headers['set-cookie']) },
    });
    expect(me.json()).toMatchObject({ login: 'octocat', name: 'Mona' });
  });

  it('refuses users who are not on the allowlist, and mismatched state', async () => {
    ({ app } = await testApp({ github: fakeGitHub({ login: 'mallory', name: null, avatarUrl: null }) }));
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    const cookie = cookieHeader(login.headers['set-cookie']);
    const refused = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(refused.headers.location).toBe('/login?error=not_allowed');
    const forged = await app.inject({
      method: 'GET',
      url: '/auth/github/callback?code=abc&state=forged',
      headers: { cookie },
    });
    expect(forged.headers.location).toBe('/login?error=state');
  });

  it('requires a session for the API', async () => {
    ({ app } = await testApp());
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/sentry' })).statusCode).toBe(401);
  });

  it('offers the dev sign-in only in dev mode', async () => {
    ({ app } = await testApp({ config: testConfig({ auth: { mode: 'dev', devUser: 'local-op' } }) }));
    const login = await app.inject({ method: 'POST', url: '/auth/dev/login', headers: csrf });
    expect(login.statusCode).toBe(204);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookieHeader(login.headers['set-cookie']) },
    });
    expect(me.json()).toMatchObject({ login: 'local-op', authMode: 'dev' });
    await app.close();
    ({ app } = await testApp());
    expect((await app.inject({ method: 'POST', url: '/auth/dev/login', headers: csrf })).statusCode).toBe(
      404,
    );
  });
});

describe('sessions', () => {
  it('signs out for real: the cookie deletions carry Secure, which browsers require for __Host- cookies', async () => {
    ({ app } = await testApp());
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=abc&state=${state}`,
      headers: { cookie: cookieHeader(login.headers['set-cookie']) },
    });
    const clearedState = [callback.headers['set-cookie']]
      .flat()
      .find((value) => value?.startsWith('__Host-sentry_oauth='));
    expect(clearedState).toMatch(/Max-Age=0/);
    expect(clearedState).toMatch(/; Secure/);

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...csrf, cookie: cookieHeader(callback.headers['set-cookie']) },
    });
    const cleared = String(logout.headers['set-cookie']);
    expect(cleared).toMatch(/^__Host-sentry_session=;/);
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/; Secure/);
    expect(cleared).toMatch(/HttpOnly/);
  });

  it('ends the sessions of a login removed from the allowlist', async () => {
    ({ app } = await testApp());
    const cookie = await signIn(app);
    await app.close();
    const config = testConfig();
    ({ app } = await testApp({
      config: { ...config, auth: { ...config.auth, allowedUsers: ['someone-else'] } as typeof config.auth },
    }));
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('takes client error reports from signed-in users only', async () => {
    ({ app } = await testApp());
    const report = { method: 'POST' as const, url: '/api/client-errors', payload: { message: 'boom' } };
    expect((await app.inject({ ...report, headers: csrf })).statusCode).toBe(401);
    const cookie = await signIn(app);
    expect((await app.inject({ ...report, headers: { ...csrf, cookie } })).statusCode).toBe(204);
  });

  it('answers /readyz from a short cache, so the public probe costs at most one Temporal call per window', async () => {
    const gateway = fakeGateway();
    ({ app } = await testApp({ gateway }));
    for (let index = 0; index < 5; index += 1) {
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    }
    expect(gateway.ping).toHaveBeenCalledTimes(1);
  });
});

describe('operator API', () => {
  it('refuses state-changing requests without the CSRF header or from another origin', async () => {
    ({ app } = await testApp());
    const cookie = await signIn(app);
    const body = { mode: 'planned', reason: 'drill' };
    const missing = await app.inject({
      method: 'POST',
      url: '/api/sentry/failover',
      headers: { cookie },
      payload: body,
    });
    expect(missing.statusCode).toBe(403);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/sentry/failover',
      headers: { cookie, 'x-sentry-csrf': '1', origin: 'https://evil.example.com' },
      payload: body,
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it('applies the CSRF check by route, however the path is spelled', async () => {
    const gateway = fakeGateway();
    ({ app } = await testApp({ gateway }));
    const cookie = await signIn(app);
    const response = await app.inject({
      method: 'POST',
      url: '/%61pi/sentry/failover',
      headers: { cookie },
      payload: { mode: 'forced', reason: 'cross-site' },
    });
    expect(response.statusCode).toBe(403);
    expect(gateway.triggerFailover).not.toHaveBeenCalled();
  });

  it('turns the emergency failover button into an Update carrying the operator', async () => {
    const gateway = fakeGateway();
    ({ app } = await testApp({ gateway }));
    const cookie = await signIn(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sentry/failover',
      headers: { cookie, ...csrf },
      payload: { targetRegionId: 'west', mode: 'forced', reason: '  region outage  ' },
    });
    expect(response.statusCode).toBe(202);
    expect(gateway.triggerFailover).toHaveBeenCalledWith({
      targetRegionId: 'west',
      mode: 'forced',
      reason: 'region outage',
      requestedBy: 'octocat',
    });
  });

  it('validates bodies and reports the sentry refusing an action', async () => {
    const gateway = fakeGateway();
    gateway.triggerFailover.mockRejectedValueOnce(
      new GatewayError(409, 'rejected', 'A failover is already in progress'),
    );
    ({ app } = await testApp({ gateway }));
    const cookie = await signIn(app);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sentry/failover',
      headers: { cookie, ...csrf },
      payload: { mode: 'sideways', reason: 'x' },
    });
    expect(invalid.statusCode).toBe(400);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/sentry/failover',
      headers: { cookie, ...csrf },
      payload: { mode: 'planned', reason: 'drill again' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'rejected', message: 'A failover is already in progress' });
  });

  it('reports a missing sentry as 404 with a reason', async () => {
    ({ app } = await testApp({ gateway: fakeGateway(null) }));
    const cookie = await signIn(app);
    const response = await app.inject({ method: 'GET', url: '/api/sentry', headers: { cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ running: false });
  });

  it('streams the sentry state as Server-Sent Events', async () => {
    ({ app } = await testApp({ gateway: fakeGateway({ epoch: 7, mode: 'NORMAL' }) }));
    const cookie = await signIn(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/sentry/stream`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    let text = '';
    while (reader && !text.includes('event: state')) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain('event: state');
    expect(text).toContain('"epoch":7');
  });

  it('sets a strict Content-Security-Policy', async () => {
    ({ app } = await testApp());
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('replication webhook gateway', () => {
  const event = {
    eventId: 'west-p1-e2:completed',
    type: 'replication.promotion.completed',
    failoverId: 'fo-1',
    epoch: 2,
    regionId: 'west',
    lsn: 100,
    dataLossTransactions: 0,
    occurredAt: '2026-01-01T00:00:00.000Z',
    error: null,
  };

  async function post(instance: FastifyInstance, body: unknown, secret = 'webhook-secret-0123456789') {
    const payload = JSON.stringify(body);
    const signature = await createSignatureHeader({
      secret,
      method: 'POST',
      path: '/api/webhooks/replication',
      body: payload,
    });
    return instance.inject({
      method: 'POST',
      url: '/api/webhooks/replication',
      headers: { 'content-type': 'application/json', 'x-sentry-signature': signature },
      payload,
    });
  }

  it('relays a correctly signed event to the sentry as a signal', async () => {
    const gateway = fakeGateway();
    ({ app } = await testApp({ gateway }));
    const response = await post(app, event);
    expect(response.statusCode).toBe(202);
    expect(gateway.signalReplicationComplete).toHaveBeenCalledWith(
      expect.objectContaining({ ...event, receivedAt: expect.any(String) }),
    );
  });

  it('rejects bad signatures and malformed events', async () => {
    const gateway = fakeGateway();
    ({ app } = await testApp({ gateway }));
    expect((await post(app, event, 'wrong-secret-0123456789')).statusCode).toBe(401);
    expect((await post(app, { ...event, epoch: 'two' })).statusCode).toBe(400);
    expect(gateway.signalReplicationComplete).not.toHaveBeenCalled();
  });

  it('answers 5xx when the signal could not be delivered, so the sender retries', async () => {
    const gateway = fakeGateway();
    gateway.signalReplicationComplete.mockRejectedValueOnce(
      new GatewayError(504, 'timeout', 'Temporal timed out'),
    );
    ({ app } = await testApp({ gateway }));
    expect((await post(app, event)).statusCode).toBe(504);
  });
});
