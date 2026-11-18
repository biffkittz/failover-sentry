// @ts-check
/**
 * Failover Sentry edge router (Cloudflare Worker).
 *
 * Serves the protected service's public host name and proxies every request to the region the sentry made active.
 * The routing lives in Workers KV, so the data path never depends on the sentry (the control plane) being up.
 *
 *   GET  /__edge/routing   What this edge location routes by (the sentry polls it to confirm propagation).
 *   PUT  /__edge/routing   The sentry's signed routing write. Writes are ordered by (epoch, version): a write that
 *                          is older than the one stored is refused with 409, so neither a stale sentry nor a delayed
 *                          retry can roll routing back (fencing).
 *   *                      Proxied to the active region, or a 503 holding page while the sentry fails over.
 *
 * Consistency: KV is eventually consistent across Cloudflare locations (reads here use a short cache TTL). The
 * fencing check reads the value at the location that serves the sentry's writes, which sees its own writes at once.
 * See docs/ARCHITECTURE.md for the trade-off against a Durable Object.
 *
 * Plain JavaScript checked by TypeScript (JSDoc), so Terraform deploys this file as is.
 */

/**
 * @typedef {object} KvNamespace
 * @property {(key: string, options?: { type?: 'text', cacheTtl?: number }) => Promise<string | null>} get
 * @property {(key: string, value: string) => Promise<void>} put
 */

/**
 * @typedef {object} Env
 * @property {KvNamespace} ROUTING KV namespace holding the routing.
 * @property {string} ORIGINS JSON object mapping region IDs to origin base URLs.
 * @property {string} ADMIN_SECRET HMAC secret(s) for routing writes, comma-separated during a rotation.
 * @property {string} [SERVICE_NAME] Shown on the holding page.
 * @property {string} [KV_CACHE_TTL] Seconds edge locations may cache the routing (Cloudflare's minimum is 30).
 */

/**
 * @typedef {object} Routing
 * @property {'active' | 'maintenance'} mode
 * @property {string | null} activeRegionId
 * @property {number} epoch
 * @property {number} version
 * @property {string | null} failoverId
 * @property {string} updatedAt
 */

export const ROUTING_KEY = 'routing';
export const ROUTING_PATH = '/__edge/routing';
const SIGNATURE_HEADER = 'x-sentry-signature';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const HOP_BY_HOP_HEADERS = [
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
];

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

/**
 * @param {Request} request
 * @param {Env} env
 * @param {{ colo?: string, now?: () => number }} [options]
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const colo = options.colo ?? coloOf(request);
  if (url.pathname === ROUTING_PATH) {
    if (request.method === 'GET') {
      const routing = await readRouting(env, cacheTtl(env));
      return json({ routing, colo }, 200, { 'cache-control': 'no-store' });
    }
    if (request.method === 'PUT') {
      return writeRouting(request, url, env, colo, options.now ?? Date.now);
    }
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, PUT' });
  }

  const routing = await readRouting(env, cacheTtl(env));
  if (!routing || routing.mode === 'maintenance' || !routing.activeRegionId) {
    return holdingPage(request, env, routing);
  }
  const origin = parseOrigins(env)[routing.activeRegionId];
  if (!origin) {
    return errorPage(
      request,
      502,
      `No origin is configured for region "${routing.activeRegionId}".`,
      routing,
    );
  }
  return proxy(request, url, origin, routing);
}

/**
 * @param {Env} env
 * @param {number | undefined} ttl
 * @returns {Promise<Routing | null>}
 */
export async function readRouting(env, ttl) {
  const raw = await env.ROUTING.get(
    ROUTING_KEY,
    ttl === undefined ? { type: 'text' } : { type: 'text', cacheTtl: ttl },
  );
  if (!raw) {
    return null;
  }
  try {
    return /** @type {Routing} */ (JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {Env} env
 * @param {string} colo
 * @param {() => number} now
 */
async function writeRouting(request, url, env, colo, now) {
  const body = await request.text();
  const verified = await verifySignature(
    env.ADMIN_SECRET,
    request.method,
    `${url.pathname}${url.search}`,
    body,
    request.headers.get(SIGNATURE_HEADER),
    Math.floor(now() / 1000),
  );
  if (!verified.ok) {
    return json({ error: 'unauthorized', message: verified.reason }, 401);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: 'invalid_request', message: 'Body is not JSON.' }, 400);
  }
  const update = validateUpdate(parsed, parseOrigins(env));
  if (typeof update === 'string') {
    return json({ error: 'invalid_request', message: update }, 400);
  }

  // Fencing: read the freshest value this location has (no cache TTL) and order the writes.
  const current = await readRouting(env, undefined);
  if (current) {
    const order = compareOrder(update, current);
    if (order < 0) {
      return json(
        {
          error: 'stale_epoch',
          currentEpoch: current.epoch,
          currentVersion: current.version,
          message: `Write (epoch ${update.epoch}, version ${update.version}) is older than the stored routing (epoch ${current.epoch}, version ${current.version}).`,
          routing: current,
        },
        409,
      );
    }
    if (order === 0) {
      return json({ applied: false, routing: current, colo });
    }
  }
  /** @type {Routing} */
  const routing = { ...update, updatedAt: new Date(now()).toISOString() };
  await env.ROUTING.put(ROUTING_KEY, JSON.stringify(routing));
  return json({ applied: true, routing, colo });
}

/**
 * Orders writes by epoch, then by the sentry's write version.
 * @param {{ epoch: number, version: number }} a
 * @param {{ epoch: number, version: number }} b
 */
export function compareOrder(a, b) {
  if (a.epoch !== b.epoch) {
    return a.epoch < b.epoch ? -1 : 1;
  }
  if (a.version !== b.version) {
    return a.version < b.version ? -1 : 1;
  }
  return 0;
}

/**
 * @param {unknown} value
 * @param {Record<string, string>} origins
 * @returns {Omit<Routing, 'updatedAt'> | string}
 */
export function validateUpdate(value, origins) {
  if (typeof value !== 'object' || value === null) {
    return 'Body must be an object.';
  }
  const update = /** @type {Record<string, unknown>} */ (value);
  const { mode, activeRegionId, epoch, version, failoverId } = update;
  if (mode !== 'active' && mode !== 'maintenance') {
    return 'mode must be "active" or "maintenance".';
  }
  if (!Number.isSafeInteger(epoch) || /** @type {number} */ (epoch) < 0) {
    return 'epoch must be a non-negative integer.';
  }
  if (!Number.isSafeInteger(version) || /** @type {number} */ (version) < 0) {
    return 'version must be a non-negative integer.';
  }
  if (activeRegionId !== null && (typeof activeRegionId !== 'string' || !(activeRegionId in origins))) {
    return `activeRegionId must be null or one of: ${Object.keys(origins).join(', ')}.`;
  }
  if (mode === 'active' && activeRegionId === null) {
    return 'An active routing needs an activeRegionId.';
  }
  if (failoverId !== null && (typeof failoverId !== 'string' || failoverId.length > 100)) {
    return 'failoverId must be null or a string of at most 100 characters.';
  }
  return {
    mode,
    activeRegionId: /** @type {string | null} */ (activeRegionId),
    epoch: /** @type {number} */ (epoch),
    version: /** @type {number} */ (version),
    failoverId: /** @type {string | null} */ (failoverId),
  };
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {string} origin
 * @param {Routing} routing
 */
async function proxy(request, url, origin, routing) {
  const target = new URL(`${url.pathname}${url.search}`, origin);
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  /** @type {RequestInit} */
  const init = { method: request.method, headers, redirect: 'manual' };
  if (hasBody) {
    init.body = await request.arrayBuffer();
  }
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    return errorPage(
      request,
      502,
      `The active region (${routing.activeRegionId}) is not responding.`,
      routing,
    );
  }
  const response = new Response(upstream.body, upstream);
  response.headers.set('x-sentry-region', String(routing.activeRegionId));
  response.headers.set('x-sentry-epoch', String(routing.epoch));
  return response;
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Routing | null} routing
 */
function holdingPage(request, env, routing) {
  const message = routing
    ? 'We are moving this service to another region. Please try again in a few seconds.'
    : 'This service has not been assigned a region yet.';
  const response = errorPage(request, 503, message, routing, env.SERVICE_NAME);
  response.headers.set('retry-after', '15');
  response.headers.set('x-sentry-mode', routing ? routing.mode : 'unassigned');
  return response;
}

/**
 * @param {Request} request
 * @param {number} status
 * @param {string} message
 * @param {Routing | null} routing
 * @param {string} [serviceName]
 */
function errorPage(request, status, message, routing, serviceName = 'this service') {
  const headers = {
    'cache-control': 'no-store',
    'x-sentry-epoch': String(routing?.epoch ?? 0),
  };
  if ((request.headers.get('accept') ?? '').includes('application/json') || request.method !== 'GET') {
    return json({ error: status === 503 ? 'unavailable' : 'bad_gateway', message, routing }, status, headers);
  }
  const title = status === 503 ? 'Back in a moment' : 'Temporarily unavailable';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:2rem;text-align:center}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><small>${escapeHtml(serviceName)} · epoch ${routing?.epoch ?? 0}</small></p></main></body></html>`;
  return new Response(html, { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** @param {Env} env @returns {Record<string, string>} */
function parseOrigins(env) {
  try {
    const parsed = JSON.parse(env.ORIGINS || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Env} env */
function cacheTtl(env) {
  const value = Number(env.KV_CACHE_TTL ?? '30');
  return Number.isFinite(value) && value >= 30 ? value : 30;
}

/** @param {Request} request */
function coloOf(request) {
  const cf = /** @type {{ cf?: { colo?: string } }} */ (/** @type {unknown} */ (request)).cf;
  return cf?.colo ?? 'unknown';
}

const encoder = new TextEncoder();

/**
 * Verifies an `x-sentry-signature` header (same scheme as @failover-sentry/contracts/signing).
 * @param {string} secrets comma-separated
 * @param {string} method
 * @param {string} path
 * @param {string} body
 * @param {string | null} header
 * @param {number} nowSeconds
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifySignature(secrets, method, path, body, header, nowSeconds) {
  if (!header) {
    return { ok: false, reason: 'missing signature header' };
  }
  /** @type {number | null} */
  let timestamp = null;
  /** @type {string[]} */
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map((piece) => piece.trim());
    if (key === 't' && value && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) {
    return { ok: false, reason: 'malformed signature header' };
  }
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'signature timestamp outside the tolerance window' };
  }
  const message = `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
  for (const secret of (secrets || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
    const expected = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (signatures.some((candidate) => timingSafeEqual(candidate, expected))) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}

/** @param {string} a @param {string} b */
function timingSafeEqual(a, b) {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}
