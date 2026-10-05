import 'reflect-metadata';

import { getQueueToken } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { Logger } from 'nestjs-pino';

import { EnvValidationError, loadWorkspaceEnvFile } from '@company-ops/config';
import { QUEUE_NAMES } from '@company-ops/core';
import { serializeErrorForLog, withTimeout } from '@company-ops/shared';

import { loadWorkerEnv } from './config/worker-env.js';
import { WorkerModule } from './worker.module.js';

const QUEUE_READY_TIMEOUT_MS = 10_000;

async function bootstrap(): Promise<void> {
  loadWorkspaceEnvFile();
  const env = loadWorkerEnv();

  const app = await NestFactory.createApplicationContext(WorkerModule.register(env), { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  await withTimeout(
    Promise.all(QUEUE_NAMES.map((name) => app.get<Queue>(getQueueToken(name)).waitUntilReady())),
    QUEUE_READY_TIMEOUT_MS,
    'queue connections',
  );
  logger.log(`Worker ready; queues registered: ${QUEUE_NAMES.join(', ')}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // The structured logger may not exist yet (invalid configuration fails before Nest starts).
  console.error(error instanceof EnvValidationError ? error.message : serializeErrorForLog(error));
  process.exit(1);
});
