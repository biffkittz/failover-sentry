/**
 * HMAC-SHA256 request signing, shared by every component that talks to another over the public internet: the
 * regional workloads' admin API, the edge router's routing API and the console's replication webhook.
 *
 * Header format (Stripe-style): `x-sentry-signature: t=<unix seconds>,v1=<hex HMAC>`.
 * The signed message binds the timestamp, the method and the path to the body, so a captured request can't be
 * replayed against another endpoint or, after the tolerance window, at all.
 *
 * Uses WebCrypto only, so the same code runs in Node.js, in Cloudflare Workers and in browsers.
 */

const encoder = new TextEncoder();

export interface SignInput {
  secret: string;
  method: string;
  /** Path plus query string, exactly as sent (e.g. `/internal/db/promote`). */
  path: string;
  body: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
}

export interface VerifyInput {
  /** One secret, or several during a rotation (any may match). */
  secret: string | readonly string[];
  method: string;
  path: string;
  body: string;
  header: string | null | undefined;
  /** Maximum clock skew and replay window. */
  toleranceSeconds?: number;
  /** Unix seconds. Defaults to now. */
  now?: number;
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: string };

export function canonicalMessage(timestamp: number, method: string, path: string, body: string): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings in time independent of where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function createSignatureHeader(input: SignInput): Promise<string> {
  if (!input.secret) {
    throw new Error('Cannot sign a request without a secret');
  }
  const timestamp = input.timestamp ?? nowSeconds();
  const signature = await hmacHex(
    input.secret,
    canonicalMessage(timestamp, input.method, input.path, input.body),
  );
  return `t=${timestamp},v1=${signature}`;
}

export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

export interface SignedFetchInput {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Serialised as JSON. */
  body?: unknown;
  secret: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** Sends a JSON request signed with `x-sentry-signature`. The signature covers the URL's path and query. */
export async function signedFetch(input: SignedFetchInput): Promise<Response> {
  const url = new URL(input.url);
  const body = input.body === undefined ? '' : JSON.stringify(input.body);
  const signature = await createSignatureHeader({
    secret: input.secret,
    method: input.method,
    path: `${url.pathname}${url.search}`,
    body,
  });
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-sentry-signature': signature,
    ...input.headers,
  };
  if (body) {
    headers['content-type'] = 'application/json';
  }
  return (input.fetchImpl ?? fetch)(url, {
    method: input.method,
    headers,
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
}

export async function verifySignatureHeader(input: VerifyInput): Promise<VerifyResult> {
  if (!input.header) {
    return { ok: false, reason: 'missing signature header' };
  }
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) {
    return { ok: false, reason: 'malformed signature header' };
  }
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.now ?? nowSeconds();
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'signature timestamp outside the tolerance window' };
  }
  const secrets = (typeof input.secret === 'string' ? [input.secret] : [...input.secret]).filter(Boolean);
  if (secrets.length === 0) {
    return { ok: false, reason: 'no verification secret configured' };
  }
  const message = canonicalMessage(parsed.timestamp, input.method, input.path, input.body);
  for (const secret of secrets) {
    const expected = await hmacHex(secret, message);
    if (parsed.signatures.some((candidate) => timingSafeEqual(candidate, expected))) {
      return { ok: true, timestamp: parsed.timestamp };
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}
