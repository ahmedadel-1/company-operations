import { loadWorkspaceEnvFile, resolveSecretFiles } from '@company-ops/config';
import { defineConfig } from 'prisma/config';

loadWorkspaceEnvFile(import.meta.dirname);
const env = resolveSecretFiles('migrate', process.env);

// The Prisma CLI runs migrations as the ops_migrator role (DEPLOYMENT §6).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env.DATABASE_MIGRATION_URL ?? '',
  },
});
