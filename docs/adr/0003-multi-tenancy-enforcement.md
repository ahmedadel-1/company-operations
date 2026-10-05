# ADR-0003: Multi-tenancy enforcement

Date: 2026-10-02 · Status: Accepted (amended during the Phase 0 remediation pass: relation invariant, composite keys, raw-SQL rule). RLS follow-up in Phase 9.

## Context
Single database, shared schema, `organizationId` on every tenant-owned row. Tenant isolation is a security requirement. Isolation must cover not only direct reads but also **relationships**: a record in Organization A must never reference a record of Organization B (e.g. a ticket pointing at another org's project, member, Jira connection or attachment), even if the referenced UUID exists.

## Decision

### Invariants
1. **Tenant context is server-derived.** `organizationId` comes only from the authenticated session (`activeOrgId`) or, in workers, from the job payload validated against the target record. A client-supplied `organizationId` is never authority; strict schemas reject it.
2. **Every relation between tenant-owned entities MUST preserve organization identity.** Parent and child rows of any relation carry the same `organizationId`.
3. **A referenced UUID is never trusted because it exists.** It must be resolved through a tenant-scoped lookup in the current tenant context before it is linked.
4. **Foreign-tenant identifiers behave as non-existent** (`404`).

### Enforcement layers
1. **Tenant-scoped repositories** add `organizationId` to every read and write; single-row reads use `findFirst({ where: { id, organizationId } })`.
2. **Prisma guard extension** throws when a query on a tenant model lacks an `organizationId` condition (fail closed).
3. **Relation linking** goes through services that load each referenced entity via its tenant-scoped repository first.
4. **Database defense in depth — composite foreign keys.** Tenant tables expose `UNIQUE (organization_id, id)`; foreign keys between tenant tables reference `(organization_id, <fk>_id) → parent(organization_id, id)`, so the database rejects any cross-tenant relationship even if application code is wrong. Applied to all high-value relations (tickets ↔ projects/members/categories/SLA policies, links to Jira issues/PRs, project members, attachments' owners where the owner is a single table, requests ↔ workflow versions/approvers, attendance ↔ profiles/locations, integration mappings ↔ projects/connections). Polymorphic references (e.g. `attachments.owner_id`, audit `entity_id`) cannot use FKs and are protected by layers 1–3 plus tests. Prisma composite relations (`@relation(fields: [organizationId, projectId], references: [organizationId, id])`) support this.
5. **Raw SQL rule.**
   - Raw SQL (`$queryRaw`, `$executeRaw`, TypedSQL) is **not** used for tenant-owned business data unless a reviewed need exists (e.g. full-text search, counter increments, bulk upserts, `CREATE INDEX CONCURRENTLY` in migrations).
   - Approved raw SQL lives only in a central `packages/core/src/platform/db/sql/` module, uses tagged-template parameter binding (never string concatenation), and **must explicitly bind `organization_id`** as a parameter in every statement touching tenant tables.
   - `$queryRawUnsafe` / `$executeRawUnsafe` are forbidden (lint rule `no-restricted-properties`).
   - Every raw-SQL tenant operation has a dedicated cross-tenant test.
6. **Automated negative tests** for cross-tenant reads, list filters, relationship creation and relationship update (see `SECURITY.md` §4).

### Deferred
PostgreSQL Row-Level Security remains a Phase 9 evaluation: it needs `SET LOCAL app.org_id` per transaction, interacts with pooling and multi-tenant workers, and adds per-query cost. Composite FKs + guard extension provide database-level relationship protection now.

## Consequences
- Slightly wider primary/foreign keys on tenant tables; composite relations in the Prisma schema.
- Cross-tenant relationship bugs are rejected by the database, not only by code review.
- Raw SQL becomes an explicit, reviewed, tested exception.
