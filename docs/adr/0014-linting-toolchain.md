# ADR-0014: ESLint 10 linting toolchain without `eslint-config-next`

Date: 2026-10-02 · Status: Accepted

## Context
Verified on 2026-10-02:
- eslint.org/version-support: **ESLint v10.x is Current; v9.x reached EOL on 2026-08-06** (last release 9.39.5).
- `eslint-config-next` 16.3.8 declares `eslint >=9` but bundles `eslint-plugin-react` 7.37.x (peer up to `^9.7`), `eslint-plugin-import` 2.32.x (peer up to `^9`) and `eslint-plugin-jsx-a11y` 6.10.x (peer up to `^9`) — **none declare ESLint 10 support**.
- Next.js 16 upgrade guide: `next lint` is removed, `next build` no longer lints, and `@next/eslint-plugin-next` defaults to flat config "aligning with ESLint v10". `@next/eslint-plugin-next` 16.3.8 declares no ESLint peer constraint.
- ESLint-10-compatible plugins: `typescript-eslint` 8.71.0 (`eslint ^8.57 || ^9 || ^10`), `eslint-plugin-react-hooks` 7.1.1 (includes `^10`), `eslint-plugin-import-x` 4.17.1 (includes `^10`), `@eslint-react/eslint-plugin` 5.23.3 (peer `eslint *`).
- `eslint-plugin-jsx-a11y-x` (ESLint-10 fork) is version 0.2.0 — a `0.x` package.

Choosing EOL ESLint 9 only to keep `eslint-config-next` is rejected.

## Decision
- **ESLint 10.11.0** with flat config in `packages/eslint-config`.
- Base: `@eslint/js` 10.0.1, `typescript-eslint` 8.71.0 (type-aware), `eslint-plugin-import-x` 4.17.1, `eslint-config-prettier` 10.1.8, `globals`.
- Web: `@next/eslint-plugin-next` 16.3.8, `eslint-plugin-react-hooks` 7.1.1, `@eslint-react/eslint-plugin` 5.23.3.
- **Not used**: `eslint-config-next`, `eslint-plugin-react`, `eslint-plugin-import`, `eslint-plugin-jsx-a11y` (no ESLint 10 support declared), `eslint-plugin-jsx-a11y-x` (0.x).
- Accessibility is enforced by `@axe-core/playwright` checks in E2E and component tests, plus the review checklist in `UI_UX.md`. Static JSX a11y linting is re-added when a stable ESLint-10-compatible release of `eslint-plugin-jsx-a11y` exists.

## Consequences
- Supported linter line; no peer-dependency overrides.
- Temporary loss of static JSX a11y lint rules, compensated by automated runtime axe checks.
