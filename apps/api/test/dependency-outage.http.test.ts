import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@company-ops/core';
import { SESSION_COOKIE } from '@company-ops/shared';
import { errorEnvelopeSchema } from '@company-ops/validation';

import { AppModule } from '../src/app.module.js';
import { newOpaqueToken } from '../src/auth/session/session.store.js';
import { configureHttp } from '../src/bootstrap.js';
import { loadApiEnv } from '../src/config/api-env.js';

const fakePrisma = {
  $queryRaw: () => Promise.resolve([{ ok: 1 }]),
  $disconnect: () => Promise.resolve(),
  $extends: () => ({}),
};

// The real ioredis client against a closed port: what the API sees while Redis is down.
describe('Redis outage (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let bootMs = 0;

  beforeAll(async () => {
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
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureHttp(app, env);
    // Only `listen` runs the bootstrap hooks that could wait for Redis; compiling the module is
    // CPU-bound and excluded so a busy machine does not look like a blocked boot.
    const started = performance.now();
    await app.listen(0, '127.0.0.1');
    bootMs = performance.now() - started;
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots without waiting out the Redis startup grace period', () => {
    expect(bootMs).toBeLessThan(4_000);
  });

  it('answers session-backed and rate-limited requests with a prompt 503 DEPENDENCY_UNAVAILABLE', async () => {
    for (const request of [
      () => fetch(`${baseUrl}/api/v1/me`, { headers: { cookie: `${SESSION_COOKIE}=${newOpaqueToken()}` } }),
      () => fetch(`${baseUrl}/api/v1/auth/login`, { redirect: 'manual' }),
    ]) {
      const started = performance.now();
      const response = await request();
      const elapsed = performance.now() - started;
      expect(response.status).toBe(503);
      const body: unknown = await response.json();
      expect(errorEnvelopeSchema.parse(body).error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|ioredis|enableOfflineQueue/);
      expect(elapsed).toBeLessThan(1_000);
    }
  });

  it('reports Redis down on readiness while staying live', async () => {
    expect((await fetch(`${baseUrl}/api/v1/health/live`)).status).toBe(200);
    const ready = await fetch(`${baseUrl}/api/v1/health/ready`);
    expect(ready.status).toBe(503);
    expect(errorEnvelopeSchema.parse(await ready.json()).error.details).toMatchObject({
      error: { redis: { status: 'down' } },
    });
  });
});
