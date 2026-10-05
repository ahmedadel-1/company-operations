# ADR-0006: Prisma 7 GA instead of Prisma 8 RC

Date: 2026-10-02 · Status: Accepted (re-verified 2026-10-02 during remediation)

## Context
Verified on 2026-10-02:
- npm `latest` for `prisma` is **8.0.0-rc.19**; GitHub releases list `v8.0.0-rc.*` marked *pre-release*; the newest non-pre-release GitHub release is **7.10.0** (2026-08-25).
- prisma.io "Supported databases" (Prisma 8) labels PostgreSQL support as *Release candidate* and states Prisma ORM 7 keeps receiving bug fixes and security updates for 18 months after Prisma 8 reaches GA.
- Prisma 7 system requirements (prisma.io): Node `^20.19.0 || ^22.12.0 || ^24.0.0`; TypeScript 5.4+.
- Prisma 7 supported databases (prisma.io/docs/orm/v7): PostgreSQL 9.6–**18**.
- Prisma 7 requires a driver adapter for direct connections (`@prisma/adapter-pg`); the `prisma-client` generator requires an `output` path and supports `moduleFormat` `esm` | `cjs`.

The spec states: if the newest Prisma major is pre-release, use the most recent GA major.

## Decision
Use **Prisma 7.10.0** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) with `pg` 8.23.1, the `prisma-client` generator (`moduleFormat = "esm"`, output inside `packages/db/src/generated/`), and `prisma.config.ts`. Prisma packages are pinned exactly (no caret) to keep CLI and client in lock-step.

## Consequences
- Production-safe ORM on a supported line; migration SQL committed and reviewable.
- Re-evaluate Prisma 8 once GA with at least one patch release.
