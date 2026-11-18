/**
 * A tiny HTTP endpoint for the container platform's probes. The worker has no ingress; Container Apps probes the
 * container port directly. Healthy means the worker is polling its task queue.
 */
import { createServer, type Server } from 'node:http';

export function startHealthServer(port: number, isHealthy: () => { ok: boolean; state: string }): Server {
  const server = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    const { ok, state } = isHealthy();
    response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: ok ? 'ok' : 'unavailable', worker: state }));
  });
  server.listen(port, '0.0.0.0');
  return server;
}
