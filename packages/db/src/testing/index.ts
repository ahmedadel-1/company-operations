import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/** Same image and digest as infra/compose/docker-compose.dev.yml (DEPENDENCIES §6). */
export const POSTGRES_TEST_IMAGE =
  'postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722';

const execFileAsync = promisify(execFile);
const packageRoot = join(import.meta.dirname, '..', '..');
const initScripts = {
  development: join(packageRoot, '..', '..', 'infra', 'docker', 'postgres', 'init', '01-roles-and-databases.sh'),
  production: join(packageRoot, '..', '..', 'infra', 'docker', 'postgres', 'prod-init', '01-roles-and-databases.sh'),
} as const;

export interface TestDatabase {
  /** Runtime role (DML only). */
  readonly appUrl: string;
  /** Schema owner used by Prisma Migrate. */
  readonly migratorUrl: string;
  /** Container superuser; for assertions about roles and grants only. */
  readonly superuserUrl: string;
  /** Applies all migrations with `prisma migrate deploy` as the migrator role; returns CLI output. */
  migrate(): Promise<string>;
  /** Runs `prisma migrate status` as the migrator role; returns CLI output. */
  migrateStatus(): Promise<string>;
  /**
   * Runs one SQL script with psql inside the container as the given role (unaligned, tuples only).
   * Used for assertions about grants, triggers and constraints without application code paths.
   */
  psql(role: TestDatabaseRole, sql: string): Promise<PsqlResult>;
  stop(): Promise<void>;
}

/** `ops_backup` exists only with the production role script. */
export type TestDatabaseRole = 'ops_app' | 'ops_migrator' | 'ops_backup' | 'postgres';

export interface PsqlResult {
  readonly exitCode: number;
  readonly output: string;
}

function databaseUrl(container: StartedPostgreSqlContainer, user: string, password: string): string {
  const url = new URL(`postgresql://${container.getHost()}:${String(container.getPort())}/company_ops`);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function runPrisma(args: readonly string[], migrationUrl: string): Promise<string> {
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl, NO_COLOR: '1' },
  });
  return `${stdout}${stderr}`;
}

/**
 * Starts a disposable PostgreSQL 18.6 container initialised by the same role/database script as the
 * development Compose stack (ops_migrator owns `company_ops`, ops_app has DML only), or with
 * `{ roles: 'production' }` by the production script (no CREATEDB, plus the read-only ops_backup role).
 */
export async function startTestDatabase(
  options: { readonly roles?: 'development' | 'production' } = {},
): Promise<TestDatabase> {
  const passwords = {
    superuser: randomBytes(16).toString('hex'),
    app: randomBytes(16).toString('hex'),
    migrator: randomBytes(16).toString('hex'),
    backup: randomBytes(16).toString('hex'),
    keycloak: randomBytes(16).toString('hex'),
  };
  const container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE)
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword(passwords.superuser)
    .withEnvironment({
      OPS_APP_DB_PASSWORD: passwords.app,
      OPS_MIGRATOR_DB_PASSWORD: passwords.migrator,
      OPS_BACKUP_DB_PASSWORD: passwords.backup,
      KEYCLOAK_DB_PASSWORD: passwords.keycloak,
    })
    .withCopyFilesToContainer([
      {
        source: initScripts[options.roles ?? 'development'],
        target: '/docker-entrypoint-initdb.d/01-roles-and-databases.sh',
        mode: 0o755,
      },
    ])
    .start();

  const migratorUrl = databaseUrl(container, 'ops_migrator', passwords.migrator);
  const rolePasswords: Record<TestDatabaseRole, string> = {
    ops_app: passwords.app,
    ops_migrator: passwords.migrator,
    ops_backup: passwords.backup,
    postgres: passwords.superuser,
  };
  return {
    appUrl: databaseUrl(container, 'ops_app', passwords.app),
    migratorUrl,
    superuserUrl: databaseUrl(container, 'postgres', passwords.superuser),
    migrate: () => runPrisma(['migrate', 'deploy'], migratorUrl),
    migrateStatus: () => runPrisma(['migrate', 'status'], migratorUrl),
    psql: async (role, sql) => {
      const result = await container.exec(
        [
          'psql',
          '-X',
          '-q',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-h',
          '127.0.0.1',
          '-U',
          role,
          '-d',
          'company_ops',
          '-c',
          sql,
        ],
        { env: { PGPASSWORD: rolePasswords[role] } },
      );
      return { exitCode: result.exitCode, output: result.output.trim() };
    },
    stop: async () => {
      await container.stop();
    },
  };
}
