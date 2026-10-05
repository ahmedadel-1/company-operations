// Operator recovery CLI (ARCHITECTURE §3): `pnpm activity:rebuild --org <slug> [--project <code>]`.
// Re-derives project timelines from the retained `project.activity.recorded` outbox events.
import { parseArgs } from 'node:util';

import {
  EnvValidationError,
  loadWorkspaceEnvFile,
  maintenanceEnvSchema,
  parseEnv,
  resolveSecretFiles,
} from '@company-ops/config';
import { createPrismaClient } from '@company-ops/db';
import { redactSecrets } from '@company-ops/shared';

import { rebuildProjectActivity } from '../modules/projects/rebuild-activity.js';

const USAGE = 'Usage: pnpm activity:rebuild --org <organization slug> [--project <project code>]';

class UsageError extends Error {}

async function main(): Promise<void> {
  loadWorkspaceEnvFile(import.meta.dirname);
  const env = parseEnv('maintenance', maintenanceEnvSchema, resolveSecretFiles('maintenance', process.env));
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    // pnpm forwards the `--` of `pnpm activity:rebuild -- --org …`; without this it would end option parsing.
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: { org: { type: 'string' }, project: { type: 'string' } },
    strict: true,
  });
  const slug = values.org?.trim() ?? '';
  if (slug === '') {
    throw new UsageError('--org is required.');
  }
  const projectCode = values.project?.trim();

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const outcome = await rebuildProjectActivity(prisma, {
      organizationSlug: slug,
      projectCode: projectCode === '' ? undefined : projectCode,
    });
    switch (outcome.kind) {
      case 'organization_not_found':
        console.error(`No organization with slug "${slug}".`);
        process.exitCode = 1;
        break;
      case 'project_not_found':
        console.error(`No project with code "${projectCode ?? ''}" in "${slug}".`);
        process.exitCode = 1;
        break;
      case 'rebuilt':
        console.log(`Removed ${String(outcome.deleted)} timeline entries and re-created ${String(outcome.created)}.`);
        break;
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isArgumentError = (error: unknown): error is Error =>
  error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS');

main().catch((error: unknown) => {
  if (error instanceof UsageError || isArgumentError(error)) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof EnvValidationError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
  process.exitCode = 1;
});
