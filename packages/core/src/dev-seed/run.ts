// Development-only seed entry point: `pnpm db:seed` (ROADMAP P1-4). Refuses to run in production or
// without ALLOW_DEMO_SEED=true. Never invoked by application startup.
import {
  EnvValidationError,
  loadWorkspaceEnvFile,
  parseEnv,
  resolveSecretFiles,
  seedEnvSchema,
} from '@company-ops/config';
import { createPrismaClient } from '@company-ops/db';
import { redactSecrets } from '@company-ops/shared';

import { assertSeedAllowed, seedDemoData } from './seed.js';

async function main(): Promise<void> {
  loadWorkspaceEnvFile(import.meta.dirname);
  const env = parseEnv('seed', seedEnvSchema, resolveSecretFiles('seed', process.env));
  assertSeedAllowed(env.NODE_ENV, env.ALLOW_DEMO_SEED);

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const report = await seedDemoData(prisma, env.OIDC_ISSUER);
    console.log(`Development seed complete: ${JSON.stringify(report)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    redactSecrets(
      error instanceof Error
        ? error.name === 'Error'
          ? error.message
          : `${error.name}: ${error.message}`
        : String(error),
    ),
  );
  if (error instanceof EnvValidationError) {
    process.exitCode = 2;
    return;
  }
  process.exitCode = 1;
});
