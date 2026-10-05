import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { EnvValidationError, loadWorkspaceEnvFile } from '@company-ops/config';
import { serializeErrorForLog } from '@company-ops/shared';

import { AppModule } from './app.module.js';
import { configureHttp, OPENAPI_PATH, setupSwagger } from './bootstrap.js';
import { loadApiEnv } from './config/api-env.js';

async function bootstrap(): Promise<void> {
  loadWorkspaceEnvFile();
  const env = loadApiEnv();

  const app = await NestFactory.create(AppModule.register(env), { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  configureHttp(app, env);

  if (env.SWAGGER_ENABLED) {
    setupSwagger(app);
    logger.log(`OpenAPI UI enabled at /${OPENAPI_PATH}`, 'Bootstrap');
  }

  await app.listen(env.API_PORT);
  logger.log(`API listening on port ${env.API_PORT}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // The structured logger may not exist yet (invalid configuration fails before Nest starts).
  console.error(error instanceof EnvValidationError ? error.message : serializeErrorForLog(error));
  process.exit(1);
});
