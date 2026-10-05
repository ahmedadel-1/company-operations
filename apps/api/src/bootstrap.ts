import { VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';

import type { ApiEnv } from './config/api-env.js';
import { applyHttpSecurity } from './http/security.js';
import { ApiMetrics } from './infrastructure/api-metrics.js';
import { createValidationPipe } from './http/validation.js';

export const OPENAPI_PATH = 'api/v1/docs';

/** HTTP conventions shared by the server entry point, OpenAPI emission and tests. */
export function configureHttp(app: INestApplication, env: ApiEnv): void {
  app.use(app.get(ApiMetrics).middleware);
  applyHttpSecurity(app, env, OPENAPI_PATH);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Company Operations Hub API')
    .setDescription('REST API `/api/v1`. Contracts are generated from the shared Zod schemas (ADR-0004).')
    .setVersion('1')
    .addCookieAuth('__Host-ops_sid')
    .build();
  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(OPENAPI_PATH, app, () => createOpenApiDocument(app), {
    jsonDocumentUrl: `${OPENAPI_PATH}/openapi.json`,
  });
}
