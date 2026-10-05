import { parseEnv, resolveSecretFiles, workerEnvSchema } from '@company-ops/config';
import type { WorkerEnv } from '@company-ops/config';

export type { WorkerEnv };

export const WORKER_ENV = Symbol('WORKER_ENV');

export function loadWorkerEnv(source: Readonly<Record<string, string | undefined>> = process.env): WorkerEnv {
  return parseEnv('worker', workerEnvSchema, resolveSecretFiles('worker', source));
}
