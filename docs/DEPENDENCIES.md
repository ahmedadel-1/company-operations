# Dependencies & Version Verification

**Date checked: 2026-10-02** (all rows). Verification performed during the Phase 0 remediation pass.

## 1. Verification method and legend

Every row was checked against at least one official project source. Source codes:

| Code | Official source |
|---|---|
| **GH-R** | GitHub Releases API of the project's official repository (`gh api repos/<org>/<repo>/releases/latest` or `/releases/tags/<tag>`), confirmed `prerelease=false` |
| **GH-T** | Git tag present in the project's official repository (monorepos that tag per package) |
| **NPM** | npm registry (the publisher's official distribution channel): `dist-tags.latest`, `peerDependencies`, `peerDependenciesMeta`, `engines` for the exact version |
| **DOC** | Official documentation page (URL given in §7) |
| **HUB / QUAY** | Docker Hub / Quay registry API for the exact tag, digest recorded |

"Stable" = not alpha/beta/RC/canary/preview/next and published as a non-pre-release (or `latest` dist-tag). Packages at `0.x` are flagged explicitly.

**Freshness note.** Several versions were published within 48 h of the check (bullmq, turbo, AWS SDK, shadcn, lucide-react, next-intl, nestjs-pino, Sentry, Keycloak). Phase 1 (P1-1) will configure a minimum release age for dependency resolution (pnpm's `minimumReleaseAge` — exact setting name/semantics in pnpm 12 to be confirmed against pnpm docs in P1-1). If resolution selects an earlier patch of the same minor, this file is updated with the locked version. This does not change any major/minor decision below.

**Phase 1A outcome (2026-10-02).** Confirmed on pnpm.io/settings: `minimumReleaseAge` (minutes; strict when set explicitly), `minimumReleaseAgeExclude` (accepts exact `name@version`), `allowBuilds` / `strictDepBuilds` (reviewed install scripts). `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`. Because the pins are exact, resolution cannot fall back to an earlier patch; the approved versions published < 24 h before installation are instead exempted **by exact version** (`@aws-sdk/client-s3@3.1145.0`, `@aws-sdk/s3-request-presigner@3.1145.0`, `@types/node@24.19.1`, `nestjs-pino@5.3.0`, `next-intl@4.14.9` and its same-release packages `use-intl`, `icu-minify`, `next-intl-swc-plugin-extractor`). Every version installed matches this file; the exemptions are removed once those versions are older than 24 h. Install scripts allowed: `prisma`, `@prisma/engines`, `@swc/core`; denied: `@scarf/scarf` (telemetry), `@parcel/watcher`, `msgpackr-extract`, `unrs-resolver` (prebuilt binaries arrive as optional dependencies).

**Phase 1 outcome (2026-10-02).** Every package installed by the end of Phase 1 is an approved row below at exactly the listed version; nothing outside this file was added. Where each is used:

| Workspace | Runtime dependencies | Dev/test dependencies |
|---|---|---|
| `apps/api` | Nest 12 (core, common, platform-express, swagger, terminus), `@nestjs/throttler`, `bullmq` (failed-jobs admin API reads queues), `ioredis`, `helmet`, `jose`, `openid-client`, `nestjs-cls`, `nestjs-pino`/`pino`/`pino-http`, `reflect-metadata`, `rxjs` | `@nestjs/cli`, `@nestjs/testing`, `unplugin-swc`/`@swc/core`, `vitest`/`vite`, `testcontainers` |
| `apps/worker` | Nest 12 (core, common), `@nestjs/bullmq`, `bullmq`, `ioredis` (Phase 3: real-time publisher), `nodemailer` (Phase 3: SMTP `EmailChannel` adapter), `nestjs-pino`/`pino`/`pino-http`, `reflect-metadata`, `rxjs` | as API, without `@nestjs/testing` |
| `apps/web` | `next`, `react`/`react-dom`, `next-intl`, `@tanstack/react-query`, `lucide-react` | `tailwindcss`/`@tailwindcss/postcss`, `vitest` |
| `apps/e2e` | — | `@playwright/test`, `@axe-core/playwright`, `testcontainers` |
| `packages/ui` | `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` | `tailwindcss`, `vitest` |
| `packages/core` | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `file-type`, `zod` (Phase 4: validates every Jira/Atlassian response before use) | `vitest` |
| `packages/db` | `@prisma/client`, `@prisma/adapter-pg`, `pg` | `prisma`, `testcontainers`, `@testcontainers/postgresql` |
| `packages/config`, `packages/validation` | `zod` | `vitest` |
| `packages/api-client` | `openapi-fetch` | `openapi-typescript`, package-local `typescript` 5.9.3 |

Approved but **not installed yet** (added by the phase that first uses them): `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, `recharts`, `sonner`, `react-markdown`/`rehype-sanitize`, `date-fns`/`@date-fns/tz`, `@sentry/*`, `@nestjs/config` (env is parsed with Zod in `packages/config`), `supertest` (tests call the real server with `fetch`), `@testing-library/*`/`jsdom`, `undici`, `@octokit/*` (not needed through Phase 5), `shadcn` CLI (not a dependency; the owned component source lives in `packages/ui`), `cookie-parser` (replaced by a strict built-in cookie reader that rejects duplicates).

**Phase 3 outcome (2026-10-03).** Two approved packages were added to `apps/worker`, both at the exact versions listed in §4: `nodemailer` 10.0.13 (first use, the SMTP adapter behind the `EmailChannel` port; its bundled types are used, no `@types` package) and `ioredis` 6.0.0 (already used by the API; the worker now publishes real-time events). The web app reuses `EventSource` and the existing query client for live updates. Nothing outside this file was added.

**Phase 5 outcome (2026-10-03).** No new third-party package. The approved `@octokit/app` and `@octokit/webhooks` were **not** installed (ADR-0020): the GitHub client is a small typed `fetch` client (REST API version `2026-03-10`) whose responses are validated with `zod`, App JWTs are signed with `node:crypto` (RS256), and webhook signatures are checked with `node:crypto` HMAC-SHA256 and `timingSafeEqual` against GitHub's published test vector. The deterministic GitHub test double joins the Jira one in `@company-ops/core/testing` (tests only, `node:http` and `node:crypto`).

**Phase 4 outcome (2026-10-03).** No new third-party package. `packages/core` now depends directly on `zod` 4.6.5 (the version already pinned in §3 and used by `packages/config`/`packages/validation`) to validate Jira and Atlassian responses inside the adapter. The Jira client is a small typed `fetch` client against REST v3 (no Jira SDK, no `undici`); the deterministic Jira test double is part of `packages/core` (`@company-ops/core/testing`, exported for tests only) and uses `node:http` and `node:crypto`. `apps/e2e` gains a workspace dependency on `@company-ops/core` for that double.

Release-age exemptions added in Phase 1 by exact version: `@tanstack/react-query@5.104.1`, `@tanstack/query-core@5.104.1`, `lucide-react@1.50.0` (published < 24 h before first install). Reviewed install scripts additionally denied: `ssh2`, `cpu-features` (Docker-over-SSH acceleration from testcontainers), `protobufjs` (post-install notice).

`pnpm audit --audit-level high` reports three advisories in transitive dependencies of the Prisma CLI on code paths this project never runs, and one in lint-only tooling (`braces`, no patched release, absent from every image); they are ignored by GHSA id with justification in `pnpm-workspace.yaml` (ADR-0015 and its 2026-10-04 amendment). CI actions are pinned by full commit SHA in `.github/workflows/ci.yml` (versions as in §7).

**No row in this file is unverified.** Items that could not be verified were replaced by a verified alternative (see §6).

## 2. Runtime, package manager, toolchain

| Package / tool | Version | Purpose | Stable | Sources | Compatibility checks |
|---|---|---|---|---|---|
| Node.js | **24.21.0** (24 LTS) | Runtime | Yes (LTS) | nodejs.org/dist/index.json; DOC nodejs/Release schedule.json | 24: LTS 2025-10-28, maintenance 2026-10-20, EOL 2028-04-30. Satisfies every engine range below (ADR-0007) |
| pnpm | **12.8.1** | Workspace package manager | Yes | GH-R `v12.8.1`; NPM; DOC pnpm.io/installation | DOC: pnpm 12 supports Node 24; native executable; Windows install via `npx get-pnpm` (needs Node ≥ 22.13) |
| turbo | 2.11.6 | Task orchestration/caching | Yes | GH-R `v2.11.6`; NPM | No engines/peers declared |
| typescript | **6.0.3** | Type checking | Yes | GH-R/GH-T `v6.0.3`; NPM | 7.0.2 is newest stable but excluded (ADR-0005). In range for typescript-eslint (`<6.1.0`), @nestjs/swagger (`^6.0.0`), @nestjs/cli (`~6.0.2`), Next.js 16 (≥5.1, DOC), Prisma 7 (≥5.4, DOC) |
| typescript (codegen only) | 5.9.3 | Local to `packages/api-client` for openapi-typescript | Yes | NPM | Satisfies openapi-typescript peer `^5.x` (ADR-0005) |
| @types/node | **24.19.1** | Node 24 type definitions | Yes | NPM | Latest 24.x types; matches runtime major (not `latest`=26.x). Vitest peer `@types/node ^22 \|\| >=24` ✓ |
| eslint | **10.11.0** | Linting (flat config) | Yes | GH-R `v10.11.0`; DOC eslint.org/version-support (v10 Current; v9 EOL 2026-08-06) | ADR-0014 |
| @eslint/js | 10.0.1 | Base rules | Yes | GH-T `v10.0.1`; NPM | peer `eslint ^10` ✓ |
| typescript-eslint | 8.71.0 | Type-aware TS rules | Yes | GH-R `v8.71.0`; NPM | peer `eslint ^8.57 \|\| ^9 \|\| ^10`, `typescript >=4.8.4 <6.1.0` ✓ |
| eslint-plugin-import-x | 4.17.1 | Import hygiene, boundary rules | Yes | GH-R `v4.17.1`; NPM | peer `eslint ^10` ✓, `@typescript-eslint/utils ^8.56` ✓ |
| eslint-config-prettier | 10.1.8 | Disable formatting rules | Yes | NPM | — |
| globals | 17.13.0 | Global definitions | Yes | NPM | — |
| prettier | 3.9.9 | Formatting | Yes | GH-R `3.9.9`; NPM | 4.x is alpha — excluded |

## 3. Frontend (`apps/web`, `packages/ui`, `packages/api-client`)

| Package | Version | Purpose | Stable | Sources | Compatibility checks |
|---|---|---|---|---|---|
| next | **16.3.8** | App Router, RSC, standalone output, manifest | Yes | GH-R `v16.3.8`; NPM; DOC Next 16 upgrade guide | engines `>=20.9.0` ✓; peer react/react-dom `^19` ✓; TS ≥ 5.1 (DOC) ✓ |
| react / react-dom | **19.3.0** | UI runtime | Yes | GH-R `v19.3.0`; NPM | react-dom peer `react ^19.3.0` ✓ |
| @types/react / @types/react-dom | 19.3.0 | React types | Yes | NPM | @types/react-dom peer `@types/react ^19.3.0` ✓ |
| @next/eslint-plugin-next | 16.3.8 | Next.js lint rules | Yes | GH-T `v16.3.8` (Next monorepo); NPM; DOC (flat config, ESLint 10 alignment) | No ESLint peer constraint ✓ |
| eslint-plugin-react-hooks | 7.1.1 | Hooks rules | Yes | NPM | peer includes `eslint ^10` ✓ |
| @eslint-react/eslint-plugin | 5.23.3 | React rules (replaces eslint-plugin-react) | Yes | GH-R `v5.23.3`; NPM | peer `eslint *`, engines `>=22` ✓ |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | Styling, logical properties | Yes | GH-R `v4.3.3`; NPM | — |
| shadcn (CLI, dev-time only) | 4.21.1 | Generates owned component source | Yes | GH-T `shadcn@4.21.1`; NPM | engines `>=20.18.1` ✓ |
| radix-ui | 1.6.7 | Accessible primitives | Yes | GH-T `radix-ui@1.6.7`; NPM | — |
| class-variance-authority | 0.7.1 | Component variants | **0.x** (stable tag; unchanged since 2024-11) | GH-R `v0.7.1`; NPM | Tiny, no runtime deps; accepted |
| clsx / tailwind-merge | 2.1.1 / 3.7.0 | Class composition | Yes | NPM; GH-T `tailwind-merge@3.7.0` | — |
| @tanstack/react-query | 5.104.1 | Client data cache | Yes | GH-T `@tanstack/react-query@5.104.1`; NPM | peer `react ^18 \|\| ^19` ✓ |
| @tanstack/react-table | **9.2.4** | Headless tables | Yes | GH-T `@tanstack/react-table@9.2.4`; NPM | peer `react >=18`, engines `>=20` ✓. v9.0.0 published 2026-08-04; v8's last release 8.21.3 dates from 2025-04 — v9 chosen as the maintained major; the shared `DataTable` wrapper is written against the v9 API |
| react-hook-form | 7.89.0 | Forms | Yes | GH-R `v7.89.0`; NPM | peer react `^19` ✓ (v8 is beta — excluded) |
| @hookform/resolvers | 5.9.1 | Zod resolver | Yes | GH-R `v5.9.1`; NPM | peer `zod ^3.25 \|\| ^4`, `react-hook-form ^7.55` ✓ |
| zod | **4.6.5** | Shared schemas | Yes | GH-R `v4.6.5`; NPM | Implements Standard Schema (used by NestJS 12, ADR-0004) |
| recharts | 3.10.1 | Meaningful charts only | Yes | GH-R `v3.10.1`; NPM | peer react/react-dom `^19` ✓, `react-is ^19` → react-is 19.3.0 (NPM) ✓ |
| lucide-react | 1.50.0 | Single icon family | Yes | GH-R `1.50.0`; NPM | peer react `^19` ✓ |
| next-intl | 4.14.9 | i18n, RTL, locale formatting | Yes | GH-R `v4.14.9`; NPM | peer `next ^16`, `react ^19` ✓ |
| sonner | 2.0.8 | Toasts | Yes | GH-R `v2.0.8`; NPM | — |
| react-markdown / rehype-sanitize | 10.1.0 / 6.0.0 | Safe markdown rendering | Yes | GH-R `10.1.0` / `6.0.0`; NPM | — |
| date-fns / @date-fns/tz | 4.4.0 / 1.5.0 | Date math, time zones | Yes | GH-R `v4.4.0`; GH-T `v1.5.0`; NPM | — |
| openapi-typescript (dev, in `packages/api-client`) | 7.13.0 | Generate types from OpenAPI | Yes | GH-T `openapi-typescript@7.13.0`; NPM | peer `typescript ^5.x` → satisfied by package-local TS 5.9.3 (ADR-0005) |
| openapi-fetch | 0.17.0 | Typed fetch client | **0.x** (stable `latest`) | GH-T `openapi-fetch@0.17.0`; NPM | No peers; thin wrapper over `fetch`, low lock-in; accepted |
| @sentry/nextjs | 11.3.0 | Error monitoring (opt-in) | Yes | GH-R `11.3.0`; NPM | peer `next ^14 \|\| ^15 \|\| ^16.0.0-0` ✓; engines include Node 24 ✓ |

Not used: `next-auth` (Auth.js v5 is still under the `beta` dist-tag; auth is handled by the API, ADR-0002), `eslint-config-next` (ADR-0014), state-management libraries.

## 4. Backend (`apps/api`, `apps/worker`, `packages/core`, `packages/db`)

| Package | Version | Purpose | Stable | Sources | Compatibility checks |
|---|---|---|---|---|---|
| @nestjs/core, common, platform-express, testing | **12.1.2** | API/worker framework | Yes | GH-T `v12.1.2`; NPM; DOC v12.0.0 release notes | engines `>= 20` ✓; ESM packages (ADR-0013); peers `rxjs ^7.1.0`, `reflect-metadata ^0.1.12 \|\| ^0.2.0` (rows below) |
| rxjs | 7.8.2 | Nest peer | Yes | GH-T `7.8.2`; NPM | Satisfies `^7.1.0` (Nest, @nestjs/config, nestjs-pino) ✓ |
| reflect-metadata | 0.2.2 | Nest peer (decorator metadata) | **0.x** (stable `latest`) | NPM (GitHub latest release is v0.2.1; no v0.2.2 tag found) | Satisfies `^0.2.0` ✓ |
| @nestjs/cli (dev) | 12.0.8 | Build/scaffold | Yes | GH-R `12.0.8`; NPM | depends on `typescript ~6.0.2` ✓; engines `>= 20.11` ✓ |
| @nestjs/swagger | 12.0.2 | OpenAPI generation | Yes | GH-R `12.0.2`; NPM | peer `typescript ^5.5 \|\| ^6.0` ✓; `class-validator`/`class-transformer` are **optional** peers ✓; depends on `@standard-schema/spec` |
| @nestjs/config | 12.0.1 | Configuration | Yes | GH-R `12.0.1`; NPM | peer `@nestjs/common ^12` ✓ |
| @nestjs/terminus | 12.1.0 | Health/readiness | Yes | GH-R `12.1.0`; NPM | peer `@nestjs/core ^12`, `@prisma/client *` ✓ |
| @nestjs/throttler | 6.7.1 | Rate limiting | Yes | GH-R `v6.7.1`; NPM | peer includes `^12` ✓ |
| @nestjs/bullmq | 12.0.0 | Official BullMQ integration | Yes | GH-R nestjs/bull (release `@nestjs/bull@12.0.0`; repo publishes both packages); NPM `@nestjs/bullmq` 12.0.0 | peer `bullmq ^3 … \|\| ^6.0.0`, `@nestjs/* ^10 \|\| ^11 \|\| ^12` ✓ |
| bullmq | **6.3.11** | Queues, retries, repeatable jobs | Yes | GH-R `v6.3.11`; NPM; DOC docs.bullmq.io API (`minimumVersion` 5.0.0, `recommendedMinimumVersion` 6.2.0) | `ioredis >=5` optional peer → ioredis 6.0.0 ✓; Redis 8.10.2 ≥ 6.2.0 ✓ |
| ioredis | **6.0.0** | Redis client (sessions, pub/sub, throttler, BullMQ) | Yes | GH-R `v6.0.0`; NPM | engines `>=20` ✓ |
| prisma / @prisma/client / @prisma/adapter-pg | **7.10.0** (exact pin) | ORM, migrations | Yes (8.x is RC) | GH-R `7.10.0` (`prerelease=false`); NPM; DOC prisma.io v7 system requirements & supported DBs | Node `^20.19 \|\| ^22.12 \|\| ^24` ✓; TS ≥ 5.4 ✓; PostgreSQL 18 supported ✓; driver adapter required ✓ (ADR-0006) |
| pg | 8.23.1 | PostgreSQL driver for the adapter | Yes | GH-T `pg@8.23.1`; NPM | engines `>=16` ✓. **Do not move to pg 9** until `@prisma/adapter-pg` serializes queries on a transaction connection: Prisma 7.10's query interpreter issues independent plan nodes concurrently inside interactive transactions, which pg 8 queues (one `DeprecationWarning` per process) and pg 9 will reject. Application code keeps transaction queries sequential (`// Sequential:` comments). |
| nestjs-cls | 7.0.1 | AsyncLocalStorage tenant/request context | Yes | GH-R `nestjs-cls@7.0.1`; NPM | peer `@nestjs/* >=10 <13` ✓; engines `>=22` ✓ |
| nestjs-pino / pino / pino-http | 5.3.0 / 10.3.1 / 11.0.0 | Structured logging | Yes | GH-R `5.3.0`, `v10.3.1`, `v11.0.0`; NPM | nestjs-pino peer `@nestjs/* ^12.0.2`, `pino ^10`, `pino-http ^11` ✓; engines `>=22.12` ✓ |
| helmet | 8.3.0 | Security headers | Yes | GH-T `v8.3.0`; NPM | engines `>=18` ✓ |
| cookie-parser | 1.4.7 | ~~Signed cookies (OIDC transaction)~~ — not used: the OIDC transaction is stored in Redis and cookies are read by a strict built-in parser (ARCHITECTURE §6) | Yes | GH-R `1.4.7`; NPM | — |
| openid-client | 6.8.8 | OIDC relying party | Yes | GH-R `v6.8.8`; NPM | — |
| jose | 6.2.12 | JWT/JWKS verification (back-channel logout, Jira webhook JWT) | Yes | GH-R `v6.2.12`; NPM | — |
| @aws-sdk/client-s3 | 3.1145.0 | S3-compatible storage | Yes | GH-R `v3.1145.0`; NPM | engines `>=20` ✓ |
| @aws-sdk/s3-request-presigner | **3.1145.0** | Pre-signed URLs | Yes | GH-R `v3.1145.0` (aws-sdk-js-v3 monorepo release); NPM (`latest` = 3.1145.0) | engines `>=20` ✓; same release as client-s3 ✓ |
| file-type | 22.1.1 | Magic-byte MIME sniffing | Yes | GH-R `v22.1.1`; NPM | engines `>=22` ✓ (ESM) |
| @octokit/app / @octokit/webhooks | 16.1.4 / 14.2.0 | GitHub App auth + webhook verification | Yes | GH-R `v16.1.4` / `v14.2.0`; NPM | engines `>= 20` ✓; **not installed** — Phase 5 uses `fetch` + `node:crypto` instead (ADR-0020) |
| nodemailer | 10.0.13 | SMTP transport behind `EmailChannel` port | Yes | GH-R `v10.0.13`; NPM | engines `>=20` ✓ (Phase 3) |
| @sentry/nestjs | 11.3.0 | Error monitoring (opt-in) | Yes | GH-R `11.3.0`; NPM | peer `@nestjs/* ^12` ✓; engines include Node 24 ✓ |

Not added: `nestjs-zod` (no Nest 12 support), `class-validator`/`class-transformer` (ADR-0004), `@nestjs/schedule` (BullMQ repeatable jobs are cluster-safe), Jira SDKs (small typed `fetch` client against documented REST v3).

Deferred beyond Phase 1 (not Phase 1 dependencies): `@opentelemetry/sdk-node` (npm `latest` 0.222.0 — 0.x experimental line; to be re-verified when tracing is enabled in Phase 9), `@nestjs/observe` (not evaluated).

## 5. Testing

| Package | Version | Purpose | Stable | Sources | Compatibility checks |
|---|---|---|---|---|---|
| vitest / @vitest/coverage-v8 | **5.0.3** | Unit/integration runner | Yes | GH-R `v5.0.3`; NPM | engines `^22.12 \|\| ^24 \|\| >=26` ✓; peer `vite ^6.4 \|\| ^7 \|\| ^8` ✓ |
| vite | 8.3.2 | Vitest peer | Yes | NPM | ✓ |
| unplugin-swc / @swc/core | 2.0.0 / 1.16.13 | Decorator metadata for Nest under Vitest | Yes | GH-R `v2.0.0` / `v1.16.13`; NPM | unplugin-swc engines `^20.19 \|\| >=22.12` ✓; peer `@swc/core ^1.2.108` ✓ |
| supertest | 7.3.0 | HTTP integration tests | Yes | GH-R `v7.3.0`; NPM | — |
| testcontainers / @testcontainers/postgresql | 12.2.0 | Real PostgreSQL in tests | Yes | GH-R `v12.2.0`; NPM; DOC node.testcontainers.org (Docker "works out of the box") | engines `>= 22.22` ✓ (Node 24); local Docker 26.1.1 / Compose v2.27.0 present |
| @testing-library/react / @testing-library/dom | 16.3.3 / 10.4.2 | Component tests | Yes | NPM | peer react 19, `@testing-library/dom ^10` ✓ |
| jsdom | 30.1.1 | DOM for component tests | Yes | NPM | engines `^24.15.0` ✓ (Node 24.21) |
| undici (dev) | 8.11.2 | `MockAgent` HTTP fakes for adapter tests | Yes | GH-R `v8.11.2`; NPM | engines `>=22.19` ✓; tests inject the userland undici `fetch`/dispatcher explicitly rather than relying on Node's bundled copy |
| @playwright/test | **1.63.0** | E2E + viewports | Yes | GH-R `v1.63.0`; NPM | engines `>=20` ✓; Next optional peer `^1.51.1` ✓ |
| @axe-core/playwright | 4.13.0 | Automated accessibility checks | Yes | GH-R `v4.13.0`; NPM | peer `playwright-core >=1` ✓ |

## 6. Infrastructure images

| Image | Tag | Digest (index) | Purpose | Sources | Notes |
|---|---|---|---|---|---|
| `node` | `24.21.0-bookworm-slim` | `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` | App runtime base | HUB | `24-bookworm-slim` resolves to the same digest |
| `postgres` | `18.6` | `sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722` | Database | HUB | Prisma 7 supports PG 18 (DOC) |
| `redis` | `8.10.2` | `sha256:6f81e8915c60b065a524e6967e0ad1c639ba6efa84d669f823683ea04d9150ee` | Redis | HUB; GH-R `redis/redis 8.10.2` (latest, 2026-09-17) | ≥ BullMQ recommended 6.2.0 |
| `quay.io/keycloak/keycloak` | `26.8.0` | `sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc` | Identity provider | QUAY; GH-R `keycloak/keycloak 26.8.0` | ACR→LoA mapping and `acr_values` request parameter documented in the Keycloak Server Administration Guide (DOC, checked 2026-10-02) — basis of MFA step-up (ADR-0002) |
| `axllent/mailpit` | `v1.31.3` | `sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d` | Dev mail capture | HUB; GH-R `v1.31.3` | Dev only |
| `chrislusf/seaweedfs` | `4.48` | `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` | Dev/CI S3-compatible storage | HUB; GH-R `seaweedfs/seaweedfs 4.48` (latest, 2026-09-28) | ADR-0008. Replaces an unverifiable prebuilt MinIO image |
| `nginx` | `1.30.5-alpine` | `sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94` | Reverse proxy | HUB; DOC nginx.org/en/download.html (1.30.5 = stable) | — |

Not selected: prebuilt MinIO community image — the official MinIO README states the community edition is now source-only with no new pre-compiled releases, and no `minio/minio` tag could be verified on Docker Hub (API: "object not found") or Quay (API errors).

## 7. CI (GitHub Actions)

| Action / tool | Version | Purpose | Stable | Source |
|---|---|---|---|---|
| actions/checkout | v7.0.1 | Checkout | Yes | GH-R |
| actions/setup-node | v7.0.0 | Node 24 via `.nvmrc`, pnpm cache | Yes | GH-R |
| pnpm/action-setup | v6.1.0 | Install pnpm 12.8.1 | Yes | GH-R |
| actions/cache | v6.1.0 | Turbo/Playwright caches | Yes | GH-R |
| actions/upload-artifact | v7.0.1 | Test reports | Yes | GH-R |
| github/codeql-action | v4.38.2 | CodeQL SAST | Yes | GH-R |
| docker/setup-buildx-action / docker/build-push-action | v4.4.1 / v7.4.0 | Image builds (Phase 9) | Yes | GH-R |
| gitleaks (CLI binary) | v8.30.1 | Secret scanning | Yes | GH-R (`gitleaks_8.30.1_linux_x64.tar.gz` asset) |
| aquasecurity/trivy-action | v0.36.0 | Image vulnerability scan (Phase 9) | **0.x** (action versioning); latest non-pre-release | GH-R |

`gitleaks/gitleaks-action` v3.0.0 is **not** used: its README requires a `GITLEAKS_LICENSE` for organization accounts. The CLI is invoked directly instead. Actions are pinned by full commit SHA in workflow files (resolved in P1-20).

Official documentation pages consulted: nextjs.org/docs/app/guides/upgrading/version-16 · github.com/nestjs/nest/releases/tag/v12.0.0 · prisma.io/docs/orm/reference/system-requirements · prisma.io/docs/orm/v7/reference/supported-databases · prisma.io/docs/orm/reference/supported-databases (Prisma 8 status) · prisma.io/docs/orm/v7/prisma-schema/overview/generators · docs.bullmq.io (RedisConnection API, Redis compatibility) · eslint.org/version-support · pnpm.io/installation · nginx.org/en/download.html · node.testcontainers.org/supported-container-runtimes · github.com/nodejs/Release schedule.json · github.com/minio/minio README · github.com/keycloak/keycloak docs (ACR to LoA mapping) · developer.atlassian.com (Jira REST v3 issue search, webhooks) · docs.github.com (GitHub App JWT, installation tokens, setup URL, webhook validation, REST API versions; Phase 5, 2026-10-03) · github.com/gitleaks/gitleaks-action README.

## 8. Re-verification triggers

Monthly `pnpm outdated -r`; majors via upgrade PR updating this file. Specific watch items: TypeScript 7 support in typescript-eslint and @nestjs/swagger (ADR-0005); openapi-typescript TS 6 peer; Prisma 8 GA (ADR-0006); Node 26 LTS on 2026-10-28 (ADR-0007); ESLint-10-compatible `eslint-plugin-jsx-a11y` (ADR-0014); NestJS 12 Standard Schema OpenAPI output quality (ADR-0004).
