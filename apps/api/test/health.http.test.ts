import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from '@company-ops/core';
import { errorEnvelopeSchema, requestIdSchema } from '@company-ops/validation';

import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/bootstrap.js';
import { loadApiEnv } from '../src/config/api-env.js';
import { ApiMetrics } from '../src/infrastructure/api-metrics.js';
import { REDIS } from '../src/infrastructure/infrastructure.module.js';

const dependencies = { databaseUp: true, redisUp: true };

const fakePrisma = {
  $queryRaw: () => (dependencies.databaseUp ? Promise.resolve([{ ok: 1 }]) : Promise.reject(new Error('db down'))),
  $disconnect: () => Promise.resolve(),
  // The tenant-scoped client is built at startup; health checks never use it.
  $extends: () => ({}),
};

const fakeRedis = {
  status: 'ready',
  ping: () => (dependencies.redisUp ? Promise.resolve('PONG') : Promise.reject(new Error('redis down'))),
  quit: () => Promise.resolve('OK'),
};

beforeEach(() => {
  dependencies.databaseUp = true;
  dependencies.redisUp = true;
});

async function startApp(): Promise<{ app: INestApplication; baseUrl: string }> {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://test@127.0.0.1:1/test',
    REDIS_URL: 'redis://127.0.0.1:1',
    APP_PUBLIC_URL: 'http://localhost:3000',
    OIDC_ISSUER: 'http://127.0.0.1:1/realms/test',
    OIDC_ALLOW_INSECURE_HTTP: 'true',
    OIDC_CLIENT_SECRET: 'unit-test-client-secret',
    APP_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'unit-test',
    S3_ACCESS_KEY_ID: 'unit-test',
    S3_SECRET_ACCESS_KEY: 'unit-test',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(PrismaClient)
    .useValue(fakePrisma)
    .overrideProvider(REDIS)
    .useValue(fakeRedis)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureHttp(app, env);
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: await app.getUrl() };
}

describe('health endpoints (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health/live returns ok and a generated request id', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
    expect(requestIdSchema.safeParse(response.headers.get('x-request-id')).success).toBe(true);
  });

  it('echoes a valid client request id and replaces an invalid one', async () => {
    const id = '0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10';
    const echoed = await fetch(`${baseUrl}/api/v1/health/live`, { headers: { 'x-request-id': id } });
    expect(echoed.headers.get('x-request-id')).toBe(id);

    const replaced = await fetch(`${baseUrl}/api/v1/health/live`, { headers: { 'x-request-id': 'nope' } });
    const replacedId = replaced.headers.get('x-request-id');
    expect(replacedId).not.toBe('nope');
    expect(requestIdSchema.safeParse(replacedId).success).toBe(true);
  });

  it('GET /api/v1/health/ready reports database and redis', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      info: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('readiness failure returns 503 in the error envelope', async () => {
    dependencies.redisUp = false;
    const id = '0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e11';
    const response = await fetch(`${baseUrl}/api/v1/health/ready`, { headers: { 'x-request-id': id } });
    expect(response.status).toBe(503);
    const body: unknown = await response.json();
    const envelope = errorEnvelopeSchema.parse(body);
    expect(envelope.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(envelope.error.requestId).toBe(id);
    expect(envelope.error.details).toMatchObject({
      error: { redis: { status: 'down', message: 'unreachable' } },
    });
    expect(JSON.stringify(body)).not.toContain('redis down');
  });

  it('unknown routes return 404 in the error envelope', async () => {
    const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(response.status).toBe(404);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('NOT_FOUND');
  });

  it('routes are only served under /api/v1', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(404);
  });

  it('records request metrics by route template and status class, never concrete paths', async () => {
    await fetch(`${baseUrl}/api/v1/health/live`);
    await fetch(`${baseUrl}/api/v1/does-not-exist/0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10`);
    const render = (): Promise<string> => app.get(ApiMetrics).registry.render(); // Requests are counted on the server's `finish` event, which may run after the client has the response.
    await expect.poll(render, { timeout: 2_000 }).toContain('route="unmatched",status="4xx"');
    const text = await render();
    expect(text).toMatch(/ops_http_requests_total\{method="GET",route="[^"]*health\/live",status="2xx"\} [1-9]/);
    expect(text).toContain('route="unmatched",status="4xx"');
    expect(text).not.toContain('0191f6d0');
    expect(text).not.toContain('*path');
    expect(text).toMatch(
      /ops_http_request_duration_seconds_bucket\{method="GET",route="[^"]*health\/live",le="\+Inf"\}/,
    );
  });
});

describe('health endpoints while shutting down (HTTP)', () => {
  it('reports not ready while shutting down but stays live', async () => {
    // Draining cannot be undone, so this test owns its application instance.
    const { app, baseUrl } = await startApp();
    try {
      app.get(ApiMetrics).beforeApplicationShutdown();
      const ready = await fetch(`${baseUrl}/api/v1/health/ready`);
      expect(ready.status).toBe(503);
      expect(errorEnvelopeSchema.parse(await ready.json()).error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect((await fetch(`${baseUrl}/api/v1/health/live`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
