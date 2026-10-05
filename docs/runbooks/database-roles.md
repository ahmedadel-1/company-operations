# Runbook: database roles and privileges

PostgreSQL 18. Four login roles, created by `infra/docker/postgres/prod-init/01-roles-and-databases.sh`
on the first start of the bundled server. For an external server, run the same statements as a
superuser or the provider's admin role before the first migration.

| Role | Used by | Can | Cannot |
|---|---|---|---|
| `ops_migrator` | `migrate` job only | own the `public` schema of `company_ops`; DDL through migrations | create databases or roles; superuser |
| `ops_app` | API and worker (`database_url`) | `CONNECT`; schema `USAGE`; `SELECT/INSERT/UPDATE/DELETE` on tables and sequence use, through default privileges | `CREATE` in the schema, `TRUNCATE`, own or alter anything, create functions, disable triggers (including the append-only audit triggers), `UPDATE`/`DELETE` on audit tables (revoked by migration) |
| `ops_backup` | `backup` service | `pg_read_all_data` (read every table) on `company_ops` and `keycloak` | write anything |
| `keycloak` | Keycloak | own the `keycloak` database | connect to `company_ops` |

`PUBLIC` has no privileges on either database or on the `public` schema. `ops_app` has
`idle_in_transaction_session_timeout = 5min`, so a crashed request cannot hold locks indefinitely.
Connections use SCRAM-SHA-256.

These properties are enforced by 19 tests in `packages/core/test/platform/production-roles.int.test.ts`, run
against PostgreSQL 18 with the production init script. Examples: `ops_app` gets `permission denied` for
`CREATE TABLE`, `TRUNCATE`, `ALTER TABLE … DISABLE TRIGGER`, `UPDATE audit_logs`; `ops_backup` cannot
insert; `PUBLIC` cannot connect.

## Why no row-level security

Tenant isolation is enforced in the application: a guarded Prisma client and composite tenant foreign
keys (ADR-0003). PostgreSQL RLS was evaluated in Phase 9 and not adopted for V1 (ADR-0025): it would
need a per-transaction tenant setting on every query path, including the cross-tenant outbox relay and
maintenance jobs, and gives limited extra protection given this role separation.

## Raw SQL

Raw SQL is allowed only through tagged templates in `packages/core/src/platform/db/sql/` (parameters
are always bound). A lint rule rejects `$queryRawUnsafe` / `$executeRawUnsafe` and raw SQL outside that
directory (`SECURITY.md` §4). Migrations are reviewed like code.

## Operations

- **Inspect privileges:** `dc exec -T postgres psql -U postgres -d company_ops -c '\dp'` and `\ddp`
  (default privileges).
- **New tables** created by `ops_migrator` automatically grant DML to `ops_app` (default privileges).
  A migration creating objects as another role would break this, and the role tests would catch it.
- **Different role names** (managed database policies): the migrations revoke audit-table privileges
  only from a role literally named `ops_app` (`DEPLOYMENT.md` §9). Keep the names.
- **Password rotation:** `docs/runbooks/secrets.md`.
- **Connection budget:** `max_connections` 200 (`POSTGRES_MAX_CONNECTIONS`). Each API or worker process
  opens at most 10 connections (the node-postgres pool default), and
  Keycloak at most 100 (its default pool). One API, one worker and Keycloak therefore need at most 120.
  Each additional API replica adds 10. A managed database with a lower limit needs a smaller Keycloak
  pool (`KC_DB_POOL_MAX_SIZE`, for example 20).
