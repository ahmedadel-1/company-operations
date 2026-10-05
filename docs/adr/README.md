# Architecture Decision Records

Format: Context → Decision → Consequences.

Rule: ADRs were drafted and revised during Phase 0; revisions made before Phase 0 approval are noted in each ADR's status line. **After Phase 0 approval, accepted ADRs are immutable** — a changed decision gets a new ADR that supersedes and links back.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-and-repo-layout.md) | Modular monolith and monorepo layout | Accepted (amended) |
| [0002](0002-authentication-bff-sessions.md) | Authentication: Keycloak OIDC, API-side BFF sessions, app-owned authorization, MFA step-up | Accepted (amended) |
| [0003](0003-multi-tenancy-enforcement.md) | Multi-tenancy enforcement: relation invariant, composite FKs, raw-SQL rule | Accepted (amended) |
| [0004](0004-shared-zod-validation.md) | Shared Zod schemas with NestJS 12 native Standard Schema validation | Accepted (revised) |
| [0005](0005-typescript-6.md) | Pin TypeScript 6.0 instead of 7.0 | Accepted |
| [0006](0006-prisma-7-ga.md) | Prisma 7 GA instead of Prisma 8 RC | Accepted |
| [0007](0007-node-24-lts.md) | Node.js 24 LTS baseline | Accepted |
| [0008](0008-object-storage.md) | S3-compatible storage abstraction; development storage choice | Accepted (revised) |
| [0009](0009-vitest.md) | Vitest as the single unit/integration test runner | Accepted |
| [0010](0010-super-admin-platform-role.md) | SUPER_ADMIN is a platform-level role | Accepted |
| [0011](0011-phase-boundary-adjustments.md) | Phase boundary adjustments | Accepted |
| [0012](0012-identity-membership-and-permission-catalog.md) | Global identity, org membership, per-org roles, code-defined permissions | Accepted |
| [0013](0013-esm-module-format.md) | ESM as the module format | Accepted |
| [0014](0014-linting-toolchain.md) | ESLint 10 toolchain without eslint-config-next | Accepted |
| [0015](0015-dependency-audit-exceptions.md) | Dependency audit gate and reviewed exceptions | Accepted |
| [0016](0016-client-ip-and-rate-limit-buckets.md) | Client IP derivation and rate-limit buckets | Accepted |
| [0017](0017-projects-module-decisions.md) | Projects module decisions (Phase 2) | Accepted |
| [0018](0018-support-operations-decisions.md) | Support operations decisions (Phase 3) | Accepted |
| [0019](0019-jira-cloud-integration-decisions.md) | Jira Cloud integration decisions (Phase 4) | Accepted |
| [0020](0020-github-integration-decisions.md) | GitHub integration decisions (Phase 5) | Accepted |
| [0021](0021-requests-and-approvals-decisions.md) | Requests and approvals decisions (Phase 6) | Accepted |
| [0022](0022-attendance-decisions.md) | Attendance decisions (Phase 7) | Accepted |
| [0023](0023-dashboards-search-checklist-preferences.md) | Dashboards, Needs Attention, search, setup checklist and preferences (Phase 8) | Accepted |
| [0024](0024-observability-metrics-and-health.md) | Observability: metrics, health and logs without a vendor SDK (Phase 9) | Accepted |
| [0025](0025-postgresql-rls-evaluation.md) | PostgreSQL Row-Level Security evaluation: not enabled in V1, compensating controls (Phase 9) | Accepted |
| [0026](0026-tenders-and-contracts-decisions.md) | Tenders and contract lifecycle: approval boundary, readiness, dates, money, confidentiality, projection, recurrence (Phase 10) | Accepted |
