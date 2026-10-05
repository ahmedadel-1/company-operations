# ADR-0025: PostgreSQL Row-Level Security evaluation (ADR-0003 follow-up)

Date: 2026-10-04 · Status: Accepted (Phase 9, P9-7) · Decision: **option B — RLS not enabled in V1; compensating controls in force**

## Context
ADR-0003 deferred Row-Level Security to Phase 9. Tenant isolation is enforced today by server-derived tenant context, a fail-closed Prisma guard extension (every tenant-model query must carry `organizationId`), composite `(organization_id, id)` foreign keys, a central raw-SQL module with explicit `organization_id` binding, and cross-tenant negative tests. Phase 9 required a real evaluation, not an opinion.

## Evaluation (measured 2026-10-04, PostgreSQL 18.6, production roles from `prod-init`)
A scratch database restored from the rehearsal backup (`scripts/release/rehearse.ts restore-drill`) with forced RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY`) and the policy `organization_id = nullif(current_setting('app.org_id', true), '')::uuid`, queried as `ops_app`:

| Probe | Result |
|---|---|
| Query without `app.org_id` | 0 rows (fails closed, silently) |
| `set_config('app.org_id', <org>, true)` inside a transaction | exactly the organization's rows (10 000 of 1 000 000) |
| Same transaction, explicit filter on another organization | 0 rows |
| After `COMMIT` (setting is transaction-local) | 0 rows |
| Cross-tenant worker sweep (outbox) as `ops_app` | 0 rows: the sweep stops working |
| Overhead, 50-row keyset page on 1 M rows | 0.07 ms with policy vs 0.10 ms without (one-time filter; within noise) |
| Overhead, per-organization `count(*)` of 10 000 rows | 10.6 ms vs 9.5 ms (within noise) |

Planner cost is not the obstacle. The obstacles are structural:
1. **Every statement needs the setting in the same transaction.** With Prisma 7 and the `pg` adapter pool, that means wrapping every operation in a transaction that first runs `set_config`. The codebase has 110 interactive `$transaction` call sites, which Prisma cannot nest; a query extension that wraps operations would double round trips for every non-transactional read and cannot be applied inside existing interactive transactions without threading the setting manually through all 110.
2. **Fail-closed means silently empty, not an error.** A missed setting turns uniqueness probes, idempotency replays and "does this already exist" checks into false negatives, which can create duplicates instead of denying access. The guard extension fails loudly instead.
3. **Cross-tenant background work is by design.** Seven SQL modules run organization-independent sweeps (outbox claim, SLA and support sweeps, attendance closing, Jira and GitHub scans, attachment maintenance, daily-report checks). Under RLS they need a `BYPASSRLS` role or per-organization iteration; a bypass role in the worker would remove the protection exactly where most raw SQL lives.
4. **Composite foreign keys already provide the database-level relationship guarantee** RLS is usually adopted for (a row of organization A can never reference a row of organization B).

## Decision
Do not enable RLS in V1. Keep, and keep testing, the compensating controls below. Revisit when one of the triggers applies.

### Compensating controls (all in force and tested)
- Prisma tenant guard extension rejects any tenant-model query without an `organizationId` condition; unsafe raw APIs throw at runtime (`tenant-guard.ts`, security integration tests).
- Composite `(organization_id, id)` foreign keys on all high-value relations; integration tests insert cross-organization rows for every composite FK and expect PostgreSQL to reject them.
- Raw SQL only in `packages/core/src/platform/db/sql/`, tagged templates with an explicit `organization_id` parameter; ESLint bans `$queryRawUnsafe`, `$executeRawUnsafe` and `Prisma.raw()` everywhere and tagged raw SQL outside that module (`packages/eslint-config/base.js`).
- Database role separation (`docs/runbooks/database-roles.md`): the runtime role `ops_app` has DML only, no DDL, no `TRUNCATE`, no ownership, cannot disable the append-only audit triggers; 19 privilege tests (`production-roles.int.test.ts`).
- Cross-tenant negative tests per module (reads, list filters, relationship creation and update, raw-SQL statements, search, dashboards cache keys).
- Every query plan of the hot paths is index-backed with an organization predicate (Phase 9 EXPLAIN audit with `enable_seqscan=off`).

### Revisit triggers
- Direct database access by anything other than the application (BI tools, ad-hoc SQL by support staff).
- A per-request transaction model becomes available in the ORM layer without nesting limits.
- A tenant isolation defect that the guard extension did not catch.

## Consequences
- Isolation remains an application-plus-schema guarantee, not a database-session guarantee; the controls above are release gates.
- No `app.org_id` plumbing, no `BYPASSRLS` role, no double round trips.
- The evaluation script is reproducible against any restore-drill database.
