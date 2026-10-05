# ADR-0009: Vitest as the single unit/integration test runner

Date: 2026-10-02 · Status: Accepted

## Context
The master spec mandates testing but not a runner. NestJS historically defaulted to Jest; the NestJS v12.0.0 release notes state that ESM, Vitest and oxlint are the defaults for newly generated projects. The web app and shared packages are ESM-first (ADR-0013). Two runners would double configuration, coverage tooling and mocking idioms.

## Decision
Use **Vitest 5** (`vitest`, `@vitest/coverage-v8`) for unit and integration tests in every package. NestJS decorator metadata is supported via `unplugin-swc` + `@swc/core`. Playwright remains the E2E runner.

Integration tests use a real PostgreSQL: Testcontainers locally, GitHub Actions service containers in CI (selected via `TEST_DATABASE_URL`). Each test file gets an isolated database created from migrations.

## Consequences
- One runner, one coverage tool, consistent mocking.
- Requires Node ≥ 22.12 (satisfied by ADR-0007).
