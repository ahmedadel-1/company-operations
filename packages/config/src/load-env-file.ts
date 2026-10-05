import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Nearest ancestor directory (inclusive) that contains `pnpm-workspace.yaml`. */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Loads `<workspace root>/.env` for local development. Variables already present in the process
 * environment take precedence. Never loads anything when NODE_ENV is `production`: production
 * configuration comes from the environment or Docker secrets only.
 */
export function loadWorkspaceEnvFile(startDir: string = process.cwd()): string | undefined {
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }
  const root = findWorkspaceRoot(startDir);
  if (root === undefined) {
    return undefined;
  }
  const file = join(root, '.env');
  if (!existsSync(file)) {
    return undefined;
  }
  process.loadEnvFile(file);
  return file;
}
