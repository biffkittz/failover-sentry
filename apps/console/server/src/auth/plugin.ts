/**
 * Authentication: GitHub sign-in for an allowlist of logins (or a dev sign-in, never in production), a sealed
 * HTTP-only session cookie, and the `requireUser` guard the API routes use.
 */
import type { ConsoleUser } from '@failover-sentry/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ConsoleConfig } from '../config.js';
import {
  cookieNames,
  isSessionValid,
  nowSeconds,
  safeReturnTo,
  Sealer,
  type OAuthState,
  type Session,
} from '../session.js';
import { pkcePair, randomState, type GitHubClient } from './github.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: ConsoleUser | null;
  }
  interface FastifyInstance {
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthOptions {
  config: ConsoleConfig;
  github: GitHubClient | null;
}

async function auth(app: FastifyInstance, { config, github }: AuthOptions): Promise<void> {
  const sessions = new Sealer(config.sessionSecret, 'session');
  const oauthStates = new Sealer(config.sessionSecret, 'oauth-state');
  const secure =
    config.publicUrl.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(config.publicUrl.hostname);
  const { session: SESSION_COOKIE, oauth: OAUTH_COOKIE } = cookieNames(secure);
  // HttpOnly: scripts (and so XSS) can't read the session. SameSite=Lax: not sent on cross-site POSTs, yet still
  // sent on the top-level redirect back from GitHub, which the OAuth state cookie needs.
  const cookieBase = { path: '/', httpOnly: true, secure, sameSite: 'lax' as const };
  const redirectUri = new URL('/auth/github/callback', config.publicUrl).toString();

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const session = sessions.open<Session>(request.cookies[SESSION_COOKIE]);
    request.user = isSessionValid(session)
      ? { login: session.login, name: session.name, avatarUrl: session.avatarUrl }
      : null;
  });

  app.decorate('requireUser', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.code(401).send({ error: 'unauthenticated', message: 'Sign in to use the console.' });
    }
  });

  const startSession = (reply: FastifyReply, user: ConsoleUser): void => {
    const iat = nowSeconds();
    const session: Session = { ...user, iat, exp: iat + config.sessionTtlSeconds };
    reply.setCookie(SESSION_COOKIE, sessions.seal(session), {
      ...cookieBase,
      maxAge: config.sessionTtlSeconds,
    });
  };

  const authLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/auth/github/login', authLimit, async (request, reply) => {
    if (config.auth.mode !== 'github' || !github) {
      return reply.redirect('/login?error=github_disabled');
    }
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    const pending: OAuthState = { state, verifier, returnTo, exp: nowSeconds() + 600 };
    reply.setCookie(OAUTH_COOKIE, oauthStates.seal(pending), { ...cookieBase, maxAge: 600 });
    return reply.redirect(github.authorizeUrl({ state, challenge, redirectUri }));
  });

  app.get('/auth/github/callback', authLimit, async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const pending = oauthStates.open<OAuthState>(request.cookies[OAUTH_COOKIE]);
    reply.clearCookie(OAUTH_COOKIE, { path: '/' });
    if (config.auth.mode !== 'github' || !github) {
      return reply.redirect('/login?error=github_disabled');
    }
    if (query.error) {
      return reply.redirect('/login?error=cancelled');
    }
    if (
      !pending ||
      pending.exp < nowSeconds() ||
      !query.state ||
      query.state !== pending.state ||
      !query.code
    ) {
      request.log.warn('OAuth callback with a missing, expired or mismatched state');
      return reply.redirect('/login?error=state');
    }
    try {
      const token = await github.exchangeCode({ code: query.code, verifier: pending.verifier, redirectUri });
      const user = await github.fetchUser(token);
      // Identity is all the console needs; the token is revoked at once (best effort).
      void github
        .revokeToken(token)
        .catch((error: unknown) =>
          request.log.warn({ err: (error as Error).message }, 'token revocation failed'),
        );
      if (!config.auth.allowedUsers.includes(user.login.toLowerCase())) {
        request.log.warn({ login: user.login }, 'sign-in refused: not on the allowlist');
        return reply.redirect('/login?error=not_allowed');
      }
      startSession(reply, user);
      request.log.info({ login: user.login }, 'signed in');
      return reply.redirect(pending.returnTo);
    } catch (error) {
      request.log.error({ err: (error as Error).message }, 'GitHub sign-in failed');
      return reply.redirect('/login?error=github');
    }
  });

  if (config.auth.mode === 'dev' && !config.production) {
    const devUser = config.auth.devUser;
    app.post('/auth/dev/login', authLimit, async (_request, reply) => {
      startSession(reply, { login: devUser, name: 'Local operator', avatarUrl: null });
      return reply.code(204).send();
    });
  }

  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/me', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'unauthenticated', authMode: config.auth.mode });
    }
    return { ...request.user, authMode: config.auth.mode };
  });
}

export const authPlugin = fp(auth, { name: 'auth', dependencies: ['@fastify/cookie'] });
