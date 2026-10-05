import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface OpsResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
}

export type OpsRoute = () => Promise<OpsResponse>;

export interface OpsServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Internal operations listener (health and metrics, ADR-0024). GET only, fixed routes, no request
 * body, no authentication: it must listen on the private container network only and is never routed
 * by the reverse proxy. A failing route answers 503 without detail.
 */
export async function startOpsServer(options: {
  readonly host: string;
  readonly port: number;
  readonly routes: Readonly<Record<string, OpsRoute>>;
}): Promise<OpsServer> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const route = options.routes[path];
    if (request.method !== 'GET' || route === undefined) {
      response.writeHead(request.method === 'GET' ? 404 : 405, { 'content-type': 'text/plain' }).end();
      return;
    }
    route().then(
      (result) => {
        response
          .writeHead(result.status, {
            'content-type': result.contentType ?? 'application/json',
            'cache-control': 'no-store',
          })
          .end(result.body);
      },
      () => {
        response.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"error"}');
      },
    );
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : options.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
