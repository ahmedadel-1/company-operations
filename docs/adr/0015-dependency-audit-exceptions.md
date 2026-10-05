# ADR-0015: Dependency audit gate and reviewed exceptions

Date: 2026-10-02 · Status: Accepted

## Context
Phase 1 adds `pnpm audit` as a CI gate (ROADMAP P1-20). On 2026-10-02 `pnpm audit` reports three advisories, all transitive dependencies of the **Prisma CLI** (`prisma@7.10.0`, exact pin, ADR-0006). The CLI reaches the production dependency graph because `@prisma/client` declares `prisma` as an optional peer:

| Advisory | Package (installed) | Severity | Fixed in |
|---|---|---|---|
| GHSA-ggr8-5vv4-36mx | deepmerge-ts 7.1.5 (via `@prisma/config`) | high | 8.0.0 |
| GHSA-3f6p-5ww8-9rcr | mysql2 3.15.3 | high | 3.22.0 |
| GHSA-rgwj-5xj2-c3m3 | mysql2 3.15.3 | moderate | 3.23.1 |

Reachability in this project:
- **deepmerge-ts**: stack exhaustion when merging recursive object graphs. `@prisma/config` merges only `packages/db/prisma.config.ts`, a static file under our control. No user input reaches it. The API and worker runtimes do not load `@prisma/config`.
- **mysql2**: MySQL wire-protocol client issues (an authentication downgrade, unbounded zlib inflate). The project uses PostgreSQL only (`@prisma/adapter-pg`). The CLI never opens a MySQL connection, and the runtimes never load mysql2.

Remediation options considered:
- **Upgrade Prisma.** This changes the approved toolchain (ADR-0006), and no Prisma 7.10.x patch with fixed dependencies was available on 2026-10-02.
- **`pnpm.overrides` for mysql2 / deepmerge-ts.** This forces versions the Prisma CLI was not released or tested with; deepmerge-ts 8 is a new major. That trades a non-reachable advisory for an untested migration tool.
- **Disable the gate.** Rejected.

## Decision
- CI runs `pnpm audit --audit-level high` across the whole workspace (production and development dependencies). Any new high or critical advisory fails the build.
- The three advisories above are listed by GHSA ID in `pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`, each with a one-line justification. Exceptions are per advisory, never per package, so a new advisory in the same package still fails the gate.
- The exceptions are re-evaluated on every Prisma upgrade and in the monthly dependency review (DEPENDENCIES §8). They are removed as soon as the Prisma CLI ships patched dependencies.

## Consequences
- The audit gate is active and strict for everything else.
- The documented exceptions are visible in review. `pnpm audit` prints the ignored count, so they cannot pass silently.

## Amendment (2026-10-04, Phase 9 release review)
A fourth advisory appeared: **GHSA-vfj7-8cjw-p6xm**, `braces` ≤ 3.0.3 (high): stack exhaustion when expanding deeply nested brace patterns. No patched release exists, so neither an upgrade nor an override can remove it.

Reachability: the only path is `@company-ops/eslint-config` → `@next/eslint-plugin-next@16.3.8` → `fast-glob` → `micromatch` → `braces`. It runs at lint time and expands the glob patterns in our own lint configuration; no external input reaches it. Verified absent from all four release images (`find / -name braces` inside `ops-api`, `ops-worker`, `ops-web`, `ops-migrate`: 0 matches).

Decision: ignored by GHSA id with a justification in `pnpm-workspace.yaml`, under the same per-advisory rule. Remove the exception when `braces` (or `micromatch`/`fast-glob`) ships a fix, or when `@next/eslint-plugin-next` drops the dependency. `pnpm audit --audit-level high` now reports "4 ignored" and no findings.
