import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSecretFiles } from '@company-ops/config';
import { defineConfig } from 'prisma/config';

// Production migration job (ops-migrate image, DEPLOYMENT §8): applies the committed migrations shipped in
// @company-ops/db as the ops_migrator role. Development and CI migrate from packages/db directly.
// The package entry is dist/index.js; schema and migrations ship next to dist (package `files`).
const dbPackage = join(dirname(fileURLToPath(import.meta.resolve('@company-ops/db'))), '..');
const env = resolveSecretFiles('migrate', process.env);

export default defineConfig({
  schema: join(dbPackage, 'prisma', 'schema.prisma'),
  migrations: {
    path: join(dbPackage, 'prisma', 'migrations'),
  },
  datasource: {
    url: env.DATABASE_MIGRATION_URL ?? '',
  },
});
