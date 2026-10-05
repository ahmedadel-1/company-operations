import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { MetricsRegistry, PROMETHEUS_CONTENT_TYPE, startOpsServer } from '@company-ops/core';
import type { Counter, Histogram, OpsServer } from '@company-ops/core';

import { API_ENV } from '../config/api-env.js';
import type { ApiEnv } from '../config/api-env.js';

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Route template of the matched handler (`/api/v1/tickets/:id`), never the concrete path or its ids.
 * Express sets `route` and `baseUrl` on the request at runtime. A wildcard template (`/api*path`) comes
 * from catch-all middleware left on a request no handler matched (no handler uses wildcards), so it is
 * reported as `unmatched` like any other unknown path.
 */
function routeOf(req: IncomingMessage): string {
  const route: unknown = Reflect.get(req, 'route');
  const path: unknown = typeof route === 'object' && route !== null ? Reflect.get(route, 'path') : undefined;
  const base: unknown = Reflect.get(req, 'baseUrl');
  return typeof path === 'string' && !path.includes('*')
    ? `${typeof base === 'string' ? base : ''}${path}`
    : 'unmatched';
}

/**
 * HTTP request metrics and the internal Prometheus listener (ADR-0024). Labels are method, route
 * template and status class only. `draining` turns readiness off as soon as shutdown begins.
 */
@Injectable()
export class ApiMetrics implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(ApiMetrics.name);
  readonly registry = new MetricsRegistry();
  private readonly requests: Counter;
  private readonly duration: Histogram;
  private server: OpsServer | null = null;
  private drainingSince: number | null = null;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.registry.registerProcessMetrics();
    this.requests = this.registry.counter('http_requests_total', 'HTTP requests by route template and status class.', [
      'method',
      'route',
      'status',
    ]);
    this.duration = this.registry.histogram(
      'http_request_duration_seconds',
      'HTTP request duration by route template.',
      DURATION_BUCKETS,
      ['method', 'route'],
    );
    this.registry.gauge('api_ready', '1 while the API accepts traffic, 0 while draining.', () => [
      { value: this.drainingSince === null ? 1 : 0 },
    ]);
  }

  get draining(): boolean {
    return this.drainingSince !== null;
  }

  /** Express middleware; register before the routes. Streams are recorded when they end. */
  readonly middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const route = routeOf(req);
      const method = req.method ?? 'UNKNOWN';
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.requests.inc({ method, route, status: `${String(Math.floor(res.statusCode / 100))}xx` });
      this.duration.observe({ method, route }, seconds);
    });
    next();
  };

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.API_OPS_PORT === 0) {
      return;
    }
    this.server = await startOpsServer({
      host: this.env.API_OPS_HOST,
      port: this.env.API_OPS_PORT,
      routes: {
        '/metrics': async () => ({
          status: 200,
          body: await this.registry.render(),
          contentType: PROMETHEUS_CONTENT_TYPE,
        }),
      },
    });
    this.logger.log(`Ops listener on ${this.env.API_OPS_HOST}:${String(this.server.port)}`);
  }

  beforeApplicationShutdown(): void {
    this.drainingSince = Date.now();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server?.close();
  }
}
