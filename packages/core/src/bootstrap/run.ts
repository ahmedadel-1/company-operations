// First-run bootstrap CLI (ROADMAP P1-5): `pnpm bootstrap --slug acme --name "Acme" ...`.
// Creates the organization and invites its first ORG_ADMIN; prints the single-use invitation link
// once. Never invoked by application start-up. In production it additionally requires
// `--confirm-production <slug>`.
import { parseArgs } from 'node:util';

import {
  bootstrapEnvSchema,
  EnvValidationError,
  loadWorkspaceEnvFile,
  parseEnv,
  resolveSecretFiles,
} from '@company-ops/config';
import { createPrismaClient } from '@company-ops/db';
import { redactSecrets } from '@company-ops/shared';

import { bootstrapOrganization } from '../modules/organizations/bootstrap-organization.js';
import { InvalidOrganizationInputError } from '../modules/organizations/provision-organization.js';
import { chooseInvitationOutput, InvitationOutputError, writeInvitationFile } from './invitation-output.js';
import { assertProductionConfirmed, ProductionConfirmationError } from './production-confirmation.js';

const USAGE = `Usage: pnpm bootstrap --slug <slug> --name <name> --time-zone <IANA zone> --work-week <1,2,3,4,5>
  --admin-name <full name> [--admin-email <email>] [--admin-employee-number <EMP-00001>]
  [--locale en|ar] [--reissue] [--confirm-production <slug>] [--invitation-file <path> | --print-invitation]
The invitation link is printed only to an interactive terminal; otherwise use --invitation-file
(new file, mode 0600) or, outside CI, --print-invitation.`;

class UsageError extends Error {}

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${name} is required.`);
  }
  return value.trim();
}

async function main(): Promise<void> {
  loadWorkspaceEnvFile(import.meta.dirname);
  const env = parseEnv('bootstrap', bootstrapEnvSchema, resolveSecretFiles('bootstrap', process.env));
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    // pnpm forwards the `--` of `pnpm bootstrap -- --slug …`; without this it would end option parsing.
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      'time-zone': { type: 'string' },
      'work-week': { type: 'string' },
      locale: { type: 'string' },
      'admin-name': { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-employee-number': { type: 'string' },
      reissue: { type: 'boolean', default: false },
      'confirm-production': { type: 'string' },
      'print-invitation': { type: 'boolean', default: false },
      'invitation-file': { type: 'string' },
    },
    strict: true,
  });
  const slug = required(values, 'slug');
  assertProductionConfirmed(env.NODE_ENV, slug, values['confirm-production']);
  const output = chooseInvitationOutput({
    interactive: process.stdout.isTTY,
    ci: (process.env.CI ?? '') !== '' && process.env.CI !== 'false',
    printFlag: values['print-invitation'],
    file: values['invitation-file'],
  });
  const workWeek = required(values, 'work-week')
    .split(',')
    .map((day) => Number.parseInt(day.trim(), 10));
  const locale = values.locale ?? 'en';
  if (locale !== 'en' && locale !== 'ar') {
    throw new UsageError('--locale must be en or ar.');
  }

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const outcome = await bootstrapOrganization(prisma, {
      organization: {
        slug,
        name: required(values, 'name'),
        timeZone: required(values, 'time-zone'),
        workWeek,
        defaultLocale: locale,
      },
      admin: {
        fullName: required(values, 'admin-name'),
        workEmail: values['admin-email'] ?? null,
        employeeNumber: values['admin-employee-number'] ?? 'ADMIN-1',
      },
      reissueInvitation: values.reissue,
    });
    // Status goes to stderr; only the link itself goes to stdout (or the file), so redirecting or
    // collecting stderr never captures the secret.
    switch (outcome.kind) {
      case 'already_bootstrapped':
        console.error(`Organization "${slug}" already has an active organization admin. Nothing changed.`);
        break;
      case 'invitation_pending':
        console.error(`An admin invitation for "${slug}" is still open. Re-run with --reissue to replace it.`);
        break;
      case 'invited': {
        const link = `${env.APP_PUBLIC_URL}/api/v1/auth/login?invitation=${encodeURIComponent(outcome.invitation.token)}`;
        const created = outcome.organizationCreated ? 'Organization created. ' : '';
        if (output.kind === 'file') {
          writeInvitationFile(output.path, link);
          console.error(
            `${created}The single-use invitation link for the first organization admin (expires ${outcome.invitation.expiresAt}) was written to ${output.path} (owner read/write only). Send it, then delete the file.`,
          );
        } else {
          console.error(
            `${created}Send this single-use invitation link to the first organization admin (expires ${outcome.invitation.expiresAt}). It is shown only once and is not logged:`,
          );
          process.stdout.write(`${link}\n`);
        }
        break;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isArgumentError = (error: unknown): error is Error =>
  error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS');

main().catch((error: unknown) => {
  if (
    error instanceof UsageError ||
    error instanceof ProductionConfirmationError ||
    error instanceof InvitationOutputError ||
    error instanceof InvalidOrganizationInputError ||
    isArgumentError(error)
  ) {
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
