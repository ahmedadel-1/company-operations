import 'reflect-metadata';

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import type { Redis } from 'ioredis';

import { AppModule } from './app.module.js';
import { configureHttp, createOpenApiDocument } from './bootstrap.js';
import { loadApiEnv } from './config/api-env.js';
import { REDIS } from './infrastructure/infrastructure.module.js';

/**
 * Writes the OpenAPI document without serving traffic. The document must not depend on the local
 * environment, so inert connection settings are used. The request-path Redis client starts connecting
 * when it is created and the app is never initialized (no shutdown hooks), so it is disconnected here;
 * otherwise its reconnect loop keeps the process alive.
 */
async function emit(target: string): Promise<void> {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://openapi@127.0.0.1:1/openapi',
    REDIS_URL: 'redis://127.0.0.1:1',
    APP_PUBLIC_URL: 'http://localhost:3000',
    OIDC_ISSUER: 'http://127.0.0.1:1/realms/openapi',
    OIDC_ALLOW_INSECURE_HTTP: 'true',
    OIDC_CLIENT_SECRET: 'openapi-inert-client-secret',
    APP_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'openapi-inert',
    S3_ACCESS_KEY_ID: 'openapi-inert',
    S3_SECRET_ACCESS_KEY: 'openapi-inert',
  });
  const app = await NestFactory.create(AppModule.register(env), { logger: false });
  configureHttp(app, env);
  const document = createOpenApiDocument(app);
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  app.get<Redis>(REDIS).disconnect();
  await app.close();
}

const target = process.argv[2];
if (target === undefined) {
  console.error('Usage: node dist/emit-openapi.js <output-file>');
  process.exit(2);
}

emit(resolve(target)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
