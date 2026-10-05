import { readFileSync } from 'node:fs';

import { EnvValidationError } from './env.js';

/** Variables that may be supplied as `<NAME>_FILE` (a mounted secret file) instead of inline. */
export const FILE_BACKED_SECRETS = [
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'REDIS_URL',
  'OIDC_CLIENT_SECRET',
  'APP_ENCRYPTION_KEY',
  'APP_ENCRYPTION_KEYS_PREVIOUS',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'SMTP_PASSWORD',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'JIRA_OAUTH_CLIENT_SECRET',
] as const;

const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * Returns a copy of `source` where each `<NAME>_FILE` listed in `FILE_BACKED_SECRETS` is replaced by
 * the file's contents under `<NAME>`. Setting both forms is rejected. Errors name the variable only;
 * file paths, contents and values are never echoed.
 */
export function resolveSecretFiles(
  scope: string,
  source: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = { ...source };
  const issues: string[] = [];
  for (const name of FILE_BACKED_SECRETS) {
    const fileVar = `${name}_FILE`;
    const path = source[fileVar]?.trim();
    resolved[fileVar] = undefined;
    if (path === undefined || path === '') {
      continue;
    }
    if ((source[name]?.trim() ?? '') !== '') {
      issues.push(`${name}: set either ${name} or ${fileVar}, not both`);
      continue;
    }
    let contents: string;
    try {
      contents = readFile(path);
    } catch {
      issues.push(`${fileVar}: the file cannot be read`);
      continue;
    }
    if (Buffer.byteLength(contents, 'utf8') > MAX_SECRET_FILE_BYTES) {
      issues.push(`${fileVar}: the file is larger than ${MAX_SECRET_FILE_BYTES} bytes`);
      continue;
    }
    resolved[name] = contents.replace(/\r\n/g, '\n').trim();
  }
  if (issues.length > 0) {
    throw new EnvValidationError(scope, issues);
  }
  return resolved;
}
