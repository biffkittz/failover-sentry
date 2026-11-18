/**
 * GitHub OAuth (web application flow, with PKCE). The console only needs to know who the user is: it reads the
 * profile once, revokes the access token right away, and keeps nothing but the login in its sealed session cookie.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ConsoleUser } from '@failover-sentry/contracts';
import { z } from 'zod';

const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string().optional() });
const errorSchema = z.object({ error: z.string(), error_description: z.string().optional() });
const userSchema = z.object({
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});

export interface GitHubClient {
  authorizeUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; verifier: string; redirectUri: string }): Promise<string>;
  fetchUser(accessToken: string): Promise<ConsoleUser>;
  revokeToken(accessToken: string): Promise<void>;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString('base64url');
}

export class HttpGitHubClient implements GitHubClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizeUrl({
    state,
    challenge,
    redirectUri,
  }: {
    state: string;
    challenge: string;
    redirectUri: string;
  }): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      // No scope: the public profile is all the console reads.
      scope: '',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      allow_signup: 'false',
    }).toString();
    return url.toString();
  }

  async exchangeCode({
    code,
    verifier,
    redirectUri,
  }: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<string> {
    const response = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    const token = tokenSchema.safeParse(body);
    if (response.ok && token.success) {
      return token.data.access_token;
    }
    const error = errorSchema.safeParse(body);
    throw new Error(
      `GitHub refused the authorization code: ${error.success ? error.data.error : `HTTP ${response.status}`}`,
    );
  }

  async fetchUser(accessToken: string): Promise<ConsoleUser> {
    const response = await this.fetchImpl('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'failover-sentry-console',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub user lookup failed: HTTP ${response.status}`);
    }
    const user = userSchema.parse(await response.json());
    return { login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null };
  }

  async revokeToken(accessToken: string): Promise<void> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    await this.fetchImpl(`https://api.github.com/applications/${encodeURIComponent(this.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
        'user-agent': 'failover-sentry-console',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}
