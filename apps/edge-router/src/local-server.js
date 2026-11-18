// @ts-check
/**
 * Runs the edge router's Worker code on Node.js, for docker compose and local development. Cloudflare isn't
 * involved: KV is in memory (with a simulated propagation delay) and the colo is "local".
 */
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { LocalKv } from './local-kv.js';
import { handleRequest } from './worker.js';

const port = Number(process.env.PORT ?? '8787');
const kv = new LocalKv({ visibilityDelayMs: Number(process.env.KV_VISIBILITY_DELAY_MS ?? '5000') });

/** @type {import('./worker.js').Env} */
const env = {
  ROUTING: kv,
  ORIGINS: process.env.ORIGINS ?? '{}',
  ADMIN_SECRET: process.env.ADMIN_SECRET ?? '',
  SERVICE_NAME: process.env.SERVICE_NAME ?? 'storefront',
  KV_CACHE_TTL: '30',
};

if (!env.ADMIN_SECRET) {
  console.error('ADMIN_SECRET is required');
  process.exit(1);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? `localhost:${port}`}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') {
        headers.set(name, value);
      } else if (Array.isArray(value)) {
        headers.set(name, value.join(', '));
      }
    }
    const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
    /** @type {RequestInit & { duplex?: 'half' }} */
    const init = { method: incoming.method ?? 'GET', headers };
    if (hasBody) {
      init.body = /** @type {ReadableStream} */ (Readable.toWeb(incoming));
      init.duplex = 'half';
    }
    const response = await handleRequest(new Request(url, init), env, { colo: 'local' });
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (response.body) {
      const body = Buffer.from(await response.arrayBuffer());
      outgoing.end(body);
    } else {
      outgoing.end();
    }
  } catch (error) {
    console.error('edge router error', error);
    outgoing.statusCode = 500;
    outgoing.end('edge router error');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      msg: 'edge router listening',
      port,
      origins: Object.keys(JSON.parse(env.ORIGINS)),
      kvDelayMs: kv.visibilityDelayMs,
    }),
  );
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
