# ADR-0007: Node.js 24 LTS baseline

Date: 2026-10-02 · Status: Accepted (re-verified 2026-10-02 during remediation)

## Context
Official Node.js release schedule (`github.com/nodejs/Release/schedule.json`, checked 2026-10-02):

| Line | LTS start | Maintenance start | End of life |
|---|---|---|---|
| 20 | 2023-10-24 | 2024-10-22 | **2026-04-30** (EOL) |
| 22 | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| 24 | 2025-10-28 | 2026-10-20 | 2028-04-30 |
| 26 | 2026-10-28 (planned) | 2027-10-20 | 2029-04-30 |

`nodejs.org/dist/index.json` lists **24.21.0** as the newest LTS release. Selected dependencies require ≥ 22.12 (Vitest 5, nestjs-pino 5.3), ≥ 22.19 (undici 8), ≥ 22.22 (testcontainers 12). Node 26 is not yet LTS on the decision date.

## Decision
Node **24 LTS** everywhere: `.nvmrc` (`24`), `engines.node: ">=24.0.0 <25"`, CI `actions/setup-node` with `node-version-file: .nvmrc`, Docker base `node:24.21.0-bookworm-slim` pinned by digest.

## Consequences
- The initial workstation (Node 20.18.1, EOL) must be upgraded before Phase 1.
- Node 24 enters Maintenance LTS on 2026-10-20 and remains supported until 2028-04-30. A planned upgrade to Node 26 will be evaluated after 2026-10-28, once all pinned dependencies declare support (tracked in `DEPENDENCIES.md` §8).
