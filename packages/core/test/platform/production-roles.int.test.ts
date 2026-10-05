import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';

/**
 * Production database roles (infra/docker/postgres/prod-init, DEPLOYMENT §6) on a clean database with
 * every migration applied: the runtime role can only read and write rows, the backup role can only
 * read, and the migrator owns the schema without cluster-level privileges.
 */
describe('production database roles', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase({ roles: 'production' });
    await db.migrate();
  }, 240_000);

  afterAll(async () => {
    await db.stop();
  });

  const refusedForApp = [
    ['CREATE TABLE', 'CREATE TABLE intruder (id int)'],
    ['ALTER TABLE', 'ALTER TABLE organizations ADD COLUMN intruder int'],
    ['DROP TABLE', 'DROP TABLE organizations'],
    ['TRUNCATE', 'TRUNCATE notifications'],
    ['CREATE FUNCTION', 'CREATE FUNCTION intruder() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'],
    ['DISABLE TRIGGER', 'ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only'],
    ['CREATE SCHEMA', 'CREATE SCHEMA intruder'],
    ['CREATE INDEX', 'CREATE INDEX intruder ON organizations (name)'],
    ['UPDATE audit', "UPDATE audit_logs SET action = 'x'"],
    ['DELETE audit', 'DELETE FROM platform_audit_logs'],
    ['read migrations table', 'SELECT count(*) FROM _prisma_migrations'],
    ['CREATE DATABASE', 'CREATE DATABASE intruder'],
    ['CREATE ROLE', 'CREATE ROLE intruder'],
  ] as const;

  it.each(refusedForApp)('ops_app cannot %s', async (_label, sql) => {
    const result = await db.psql('ops_app', sql);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/permission denied|must be owner|append-only|not allowed/i);
  });

  it('ops_app cannot pass its privileges on (PostgreSQL only warns, and grants nothing)', async () => {
    const grant = await db.psql('ops_app', 'GRANT SELECT ON organizations TO PUBLIC');
    expect(grant.output).toMatch(/no privileges were granted/);
    const result = await db.psql(
      'postgres',
      "SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'PUBLIC' AND table_schema = 'public'",
    );
    expect(result.output).toBe('0');
  });

  it('ops_app reads and writes rows', async () => {
    const result = await db.psql(
      'ops_app',
      "SELECT count(*) FROM organizations; SELECT has_table_privilege(current_user, 'outbox_events', 'INSERT, UPDATE, DELETE');",
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.split('\n')).toEqual(['0', 't']);
  });

  it('ops_app holds no table with TRUNCATE, REFERENCES or TRIGGER privileges and owns nothing', async () => {
    const result = await db.psql(
      'postgres',
      `SELECT
         (SELECT count(*) FROM information_schema.table_privileges
          WHERE grantee = 'ops_app' AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')),
         (SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'ops_app'),
         (SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE r.rolname = 'ops_app')`,
    );
    expect(result.output).toBe('0|0|0');
  });

  it('ops_app holds exactly the commercial privileges the services use', async () => {
    const checks = [
      ['tenders', 'DELETE', 't'],
      ['tender_requirements', 'DELETE', 't'],
      ['tender_requirement_links', 'UPDATE', 't'],
      ['contracts', 'UPDATE', 't'],
      ['contracts', 'DELETE', 'f'],
      ['contract_obligation_occurrences', 'DELETE', 'f'],
      ['corporate_documents', 'DELETE', 'f'],
      ['guarantees', 'DELETE', 'f'],
      ['tender_events', 'UPDATE', 'f'],
      ['tender_submissions', 'DELETE', 'f'],
      ['corporate_document_versions', 'UPDATE', 'f'],
      ['contract_renewal_actions', 'UPDATE', 'f'],
      ['commercial_reminders', 'INSERT', 't'],
      ['commercial_reminders', 'DELETE', 'f'],
    ] as const;
    const result = await db.psql(
      'postgres',
      checks
        .map(([table, privilege]) => `SELECT has_table_privilege('ops_app', '${table}', '${privilege}');`)
        .join(' '),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.split('\n')).toEqual(checks.map(([, , expected]) => expected));
  });

  it('ops_backup reads everything and writes nothing', async () => {
    const read = await db.psql(
      'ops_backup',
      'SELECT count(*) FROM audit_logs; SELECT count(*) FROM _prisma_migrations;',
    );
    expect(read.exitCode).toBe(0);
    expect(Number(read.output.split('\n')[1])).toBeGreaterThan(0);
    const write = await db.psql(
      'ops_backup',
      "INSERT INTO organizations (id) VALUES ('00000000-0000-0000-0000-000000000000')",
    );
    expect(write.exitCode).not.toBe(0);
    expect(write.output).toMatch(/permission denied/);
  });

  it('no application role has cluster-level privileges', async () => {
    const result = await db.psql(
      'postgres',
      `SELECT string_agg(rolname, ',' ORDER BY rolname)
       FROM pg_roles WHERE rolname IN ('ops_app', 'ops_migrator', 'ops_backup', 'keycloak')
         AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)`,
    );
    expect(result.output).toBe('keycloak,ops_app,ops_backup,ops_migrator');
  });

  it('ops_app leaves idle transactions after five minutes', async () => {
    const result = await db.psql('ops_app', 'SHOW idle_in_transaction_session_timeout');
    expect(result.output).toBe('5min');
  });
});
