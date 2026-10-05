# ADR-0001: Modular monolith and monorepo layout

Date: 2026-10-02 · Status: Accepted (amended during the Phase 0 remediation pass: `packages/api-client`)

## Context
The spec mandates a modular monolith (NestJS API + BullMQ workers + Next.js web) in a pnpm/Turborepo monorepo, with module boundaries clean enough to extract services later. The suggested layout has `apps/api` and `apps/worker` but no place for domain logic shared by both, and no explicit home for the database schema or the generated API contract.

## Decision
- Three deployables, each a **runtime adapter**:
  - `apps/api` — HTTP runtime adapter: controllers, guards, interceptors, SSE, webhook intake, bootstrap.
  - `apps/worker` — background runtime adapter: BullMQ processors, schedulers, bootstrap.
  - `apps/web` — Next.js UI.
- **`packages/core`** contains the domain/application modules (services, repositories, policies, state machines, integration ports and adapters). Both `apps/api` and `apps/worker` import it; neither contains business rules.
- **`packages/db`** owns the single Prisma schema, migrations, generated client and the dev-only seed.
- **`packages/validation`** owns Zod schemas shared by API and web.
- **`packages/api-client`** owns the OpenAPI-generated types + typed fetch client used by the web app (ADR-0005 explains its isolated generator toolchain).
- **`packages/i18n`** owns translation catalogs for web and emails.
- Modules communicate via exported application services or outbox domain events; cross-module table access is forbidden (`no-restricted-imports` patterns + review).
- `apps/web` must never import `packages/core` or `packages/db`.

## Consequences
- Business rules exist once; worker and API cannot diverge.
- Extracting a module later means moving its folder + tables behind an API — boundaries already exist.
- More packages than the suggested layout; Turborepo handles build ordering.
