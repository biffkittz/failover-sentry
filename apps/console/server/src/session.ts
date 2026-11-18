/**
 * Sealed cookies: JSON encrypted and authenticated with AES-256-GCM. The browser holds the session but can neither
 * read nor forge it, and the server keeps no session store (any replica can serve any request).
 *
 * The key is derived from SESSION_SECRET with HKDF, separately per purpose (session, OAuth state), so a value sealed
 * for one purpose never opens as another.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { ConsoleUser } from '@failover-sentry/contracts';

/**
 * Cookie names. Over HTTPS (and on localhost, which browsers treat as secure) they carry the `__Host-` prefix, which
 * makes browsers insist on Secure, Path=/ and no Domain: the cookie can't be set or shadowed by a sibling subdomain.
 */
export function cookieNames(secure: boolean): { session: string; oauth: string } {
  return secure
    ? { session: '__Host-sentry_session', oauth: '__Host-sentry_oauth' }
    : { session: 'sentry_session', oauth: 'sentry_oauth' };
}

export interface Session extends ConsoleUser {
  /** Issued at, expires at (unix seconds). */
  iat: number;
  exp: number;
}

export interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, purpose: 'session' | 'oauth-state') {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'failover-sentry-console', purpose, 32));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
  }

  /** Returns null for anything that wasn't sealed by this key, was tampered with, or isn't JSON. */
  open<T>(sealed: string | undefined): T | null {
    if (!sealed) {
      return null;
    }
    try {
      const raw = Buffer.from(sealed, 'base64url');
      if (raw.length < 12 + 16 + 1) {
        return null;
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const plaintext = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      return null;
    }
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isSessionValid(session: Session | null, now = nowSeconds()): session is Session {
  return Boolean(
    session && typeof session.login === 'string' && session.exp > now && session.iat <= now + 60,
  );
}

/** Only same-origin relative paths: an open redirect would let an attacker bounce users off the login. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  return value.length > 512 ? '/' : value;
}
