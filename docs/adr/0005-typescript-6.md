# ADR-0005: Pin TypeScript 6.0 instead of 7.0

Date: 2026-10-02 · Status: Accepted (re-verified 2026-10-02 during remediation)

## Context
TypeScript **7.0.2** (native compiler) is the newest stable release (GitHub release `v7.0.2`, 2026-08-20; npm `latest`). Ecosystem compatibility verified on 2026-10-02 from npm registry metadata:
- `typescript-eslint` 8.71.0 peer: `typescript >=4.8.4 <6.1.0`.
- `@nestjs/swagger` 12.0.2 peer: `typescript ^5.5.0 || ^6.0.0` (optional peer; used by its CLI plugin).
- `@nestjs/cli` 12.0.8 depends on `typescript ~6.0.2`.
- Next.js 16 requires TypeScript ≥ 5.1.0 (nextjs.org upgrade guide, version 16).
- Prisma 7 requires TypeScript ≥ 5.4 (prisma.io system requirements).
- `openapi-typescript` 7.13.0 peer: `typescript ^5.x` (see Consequences).

## Decision
Pin **TypeScript 6.0.3** (GitHub release `v6.0.3`; latest 6.x) across the monorepo, with `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `module`/`moduleResolution` `nodenext` for Node packages (ADR-0013) and `bundler` for the Next.js app.

## Consequences
- All required tooling is within declared ranges, except `openapi-typescript`, whose peer is `^5.x`. To respect that declared peer rather than override it, the OpenAPI type generator runs inside the isolated `packages/api-client` workspace package with a package-local `typescript@5.9.3` dev dependency used **only** for code generation. Generated output is plain `.d.ts` consumed by TypeScript 6 everywhere else.
- Upgrade to 7.x when typescript-eslint and @nestjs/swagger declare support.
