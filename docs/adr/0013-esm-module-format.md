# ADR-0013: ESM as the module format for all workspace packages

Date: 2026-10-02 · Status: Accepted

## Context
Verified on 2026-10-02:
- NestJS v12.0.0 release notes: all core Nest packages ship as ESM; CommonJS apps keep working via Node's `require(esm)`; `nest new` offers CJS or ESM; ESM is the default for new projects. npm metadata for `@nestjs/core` / `@nestjs/common` 12.1.2 shows `"type": "module"`.
- Prisma 7 `prisma-client` generator supports `moduleFormat` `esm` | `cjs` and recommends `esm`.
- Vitest, Next.js and the shared packages are ESM-native.

## Decision
- Every workspace package uses `"type": "module"`.
- Node packages compile with `module`/`moduleResolution` = `nodenext` and explicit `.js` extensions in relative imports; `import.meta.dirname` instead of `__dirname`.
- The Next.js app uses `moduleResolution: "bundler"` (framework convention).
- Prisma generator: `moduleFormat = "esm"`.

## Consequences
- No dual CJS/ESM builds of internal packages.
- Contributors must use `.js` extensions in relative imports in Node packages (enforced by TypeScript `nodenext`).
