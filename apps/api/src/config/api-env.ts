import { apiEnvSchema, parseEnv, resolveSecretFiles } from '@company-ops/config';
import type { ApiEnv } from '@company-ops/config';

export type { ApiEnv };

export const API_ENV = Symbol('API_ENV');

export function loadApiEnv(source: Readonly<Record<string, string | undefined>> = process.env): ApiEnv {
  return parseEnv('api', apiEnvSchema, resolveSecretFiles('api', source));
}
