# Company Operations Hub

Internal operations platform for a software company that builds and runs systems for government customers. It connects **Employees → Projects → Support → Requests → Attendance → Jira → GitHub → Management** without replacing Jira or GitHub.

> **Status: all V1 phases are implemented.**
> - Phases 1–8 are approved: foundation, projects, support operations, Jira Cloud, GitHub, requests and approvals, attendance, and dashboards with search.
> - Phase 9 (production hardening and release readiness) is complete; see [`docs/runbooks/`](docs/runbooks/) and `docs/SECURITY.md` §15i.
> - Phase 10 (tenders and contract lifecycle management) is complete; see ADR-0026 and `docs/SECURITY.md` §2.6 and §15j.
> - **Pre-production external blocker:** neither integration has been verified against live Jira Cloud or GitHub.com (no test tenants available; checklists in `docs/DEPLOYMENT.md` §6). Keep both disabled in production until those checklists pass. Phase 1: Keycloak OIDC sign-in with server-side sessions, MFA step-up, CSRF and rate limits; tenant-isolated organizations and people; scoped RBAC with audited, MFA-protected role grants; audit log API; attachments on S3-compatible storage; transactional outbox, BullMQ worker and in-app notifications; a bootstrap CLI; the responsive web shell in English and Arabic (RTL). Phase 2: projects, customers, project teams, work locations, daily reports and the project activity timeline. Phase 3: support tickets with taxonomies, triage, assignment, public replies and internal notes, watchers, append-only history, SLA policies with business hours, the SLA sweep and escalation rules, ticket attachments, email through SMTP (Mailpit in development), live updates over Server-Sent Events and the project Support tab. Phase 4: Jira Cloud connection over OAuth 2.0 (3LO) with encrypted, rotating tokens; project mappings; historical import with checkpoints and live progress; verified, deduplicated webhooks; scheduled reconciliation; sync history and failures; linking and creating Jira issues from support tickets (no internal notes ever sent); Jira status signals on tickets; and the project Jira tab. Phase 5: a GitHub App per deployment (read-only metadata, pull requests, checks and statuses; no source code) with a verified installation setup, repository-to-project mappings, a pull-request cache with review and check summaries, signed and deduplicated webhooks, initial sync and reconciliation, Jira key inference with manual links, the project GitHub tab, the ticket pull-request panel, and policy-based retention of technical integration records. Phase 6: configurable request types with a safe form builder, versioned workflows that are immutable once published, approver rules (direct manager, department manager, team lead, project and technical manager, role, member), conditional ANY/ALL steps, idempotent submission with `REQ-n` numbers, approvers frozen at activation, My requests, request detail with append-only history and attachments, the My approvals inbox, delegation, fulfillment, deduplicated notifications and SLA reminders, and the approved-request effect that Phase 7 attendance will consume. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Documentation

| Document | Contents |
|---|---|
| [PRD](docs/PRD.md) | Vision, personas, scope, systems of record, spec review (risks & decisions), business baselines, stakeholder questions |
| [Architecture](docs/ARCHITECTURE.md) | System context, runtime adapters, modules, auth + MFA step-up, request pipeline, API inventory & conventions, tenancy, real-time, email, storage, repo layout |
| [Data model](docs/DATA_MODEL.md) | Entities, composite tenant keys, constraints, indexes, retention policies |
| [Security](docs/SECURITY.md) | Threat model, permission catalog, V1 RBAC baseline, MFA, tenancy checklist, secrets, webhooks, geolocation, retention |
| [Integrations](docs/INTEGRATIONS.md) | Jira Cloud (OAuth 3LO, import, webhooks, reconciliation), GitHub App (setup, webhooks, sync, Jira association), email abstraction |
| [UI/UX](docs/UI_UX.md) | App shell, navigation, role dashboards, screens per module, states, responsive rules, accessibility, i18n/RTL |
| [Roadmap](docs/ROADMAP.md) | Local environment prerequisites, Phase 1 entry criteria, phased backlog with exit criteria |
| [Deployment](docs/DEPLOYMENT.md) | Local dev, pinned images, Docker topology, data residency, migrations, backups, recovery |
| [Runbooks](docs/runbooks/) | Production install, upgrade, rollback, secrets, backup/restore, Keycloak, TLS, Redis, database roles, observability, performance |
| [Dependencies](docs/DEPENDENCIES.md) | Versions verified from official sources, with dates and compatibility checks |
| [ADRs](docs/adr/README.md) | Architecture decision records |

## Stack (summary)

Node 24 LTS · pnpm 12 + Turborepo · Next.js 16 (App Router, PWA) · NestJS 12 · PostgreSQL 18 + Prisma 7 · Redis 8 + BullMQ · Keycloak 26 (OIDC) · S3-compatible storage · Docker Compose · GitHub Actions.

## Prerequisites

- Node.js **24 LTS** (`.nvmrc`)
- pnpm **12.8.1**, installed via the official pnpm installation instructions (on Windows: `npx get-pnpm`) — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §2
- Docker with Compose v2

## Local development

Verified on Windows 11 with Node 24.21.0, pnpm 12.8.1, Docker 26.1.1 / Compose v2.27.0:

```bash
pnpm install          # frozen to pnpm-lock.yaml in CI
pnpm env:init         # creates .env with random development secrets (.env.example has placeholders only)
pnpm infra:up         # PostgreSQL, Redis, Keycloak (realm company-ops imported), SeaweedFS, Mailpit; waits until healthy
pnpm db:migrate:deploy # applies committed migrations as ops_migrator
pnpm db:seed          # development-only demo organizations, ~30 employees and users (guarded by ALLOW_DEMO_SEED)
pnpm dev              # web http://localhost:3000 · API http://localhost:4000 · worker
```

Open <http://localhost:3000> and sign in as `employee`, `gm` (member of two organizations), `hr`,
`manager` (technical manager), `field` (field engineer who submits daily reports) or `org.admin` (TOTP
enrollment on first login) with the `KC_DEMO_USER_PASSWORD` value from your `.env`.
Privileged actions by other users ask for a second factor (step-up). See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §2 for resetting the realm and dev data. The `manager` and
`field` users were added in Phase 2: an existing local Keycloak realm must be re-imported (reset the realm)
and the seed re-run before they can sign in.

Phase 2 adds projects, customers, project teams, work locations, daily reports with attachments and
the project activity timeline. The timeline is rebuilt from retained outbox events with
`pnpm activity:rebuild --org <slug> [--project <code>]`.

Phase 3 adds support operations (`/support`, `/admin/support` and the project Support tab). Sign in as
`support` (support agent), `pm` (project manager of "Internal Helpdesk Upgrade") or `field` to try the
reporter, agent and project-manager views; re-import the Keycloak realm and re-run the seed if those users
are missing. Emails from the worker appear in Mailpit (<http://localhost:8025>). `SLA_SWEEP_INTERVAL_MS`
sets how often SLA states and escalations are evaluated (default one minute).

Phase 4 adds the Jira Cloud integration (`/admin/integrations/jira`, the ticket Development panel and the
project Jira tab). It stays disabled until `JIRA_OAUTH_CLIENT_ID`/`JIRA_OAUTH_CLIENT_SECRET` name an Atlassian
OAuth 2.0 (3LO) app whose callback is `<APP_PUBLIC_URL>/api/v1/integrations/jira/callback`; webhooks
additionally need a public `https` `APP_PUBLIC_URL` (otherwise changes arrive through hourly reconciliation).
The automated suites never call Atlassian: they run against the deterministic Jira test double in
`packages/core/src/testing/fake-jira.ts`. Setup and the live-site checklist are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §6 and [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) §1.9.

Phase 5 adds the GitHub integration (`/admin/integrations/github`, the project GitHub tab and the ticket
pull-request panel). It stays disabled until `GITHUB_APP_ID` and the other `GITHUB_APP_*`/`GITHUB_WEBHOOK_SECRET`
values name a GitHub App registered from `infra/github/app-manifest.template.json`; webhooks need a public
`https` `APP_PUBLIC_URL` (otherwise changes arrive through the 30-minute reconciliation). Retention of webhook
deliveries and sync failures is off until an organization sets a policy (`/api/v1/organization/retention-policies`).
The automated suites never call GitHub: they run against `packages/core/src/testing/fake-github.ts`. Setup, key
rotation and the live checklist are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §6 and
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) §2.6.

Phase 6 adds requests and approvals (`/requests`, `/approvals`, `/approvals/delegations` and
`/admin/request-types`). The development seed publishes seven demo request types (Leave, Work from home,
Laptop, Software access, Purchase, Business mission and, since Phase 7, Short permission); a real organization starts with none, and an administrator
holding `request.admin` (fresh MFA required) creates and publishes them. `REQUEST_SLA_SWEEP_INTERVAL_MS` sets how
often overdue approvals are reminded (default five minutes). Design decisions are in ADR-0021.

Phase 7 adds attendance (`/attendance`, `/attendance/team`, `/admin/attendance`): check-in and check-out
with the position read once per tap and judged on the server (geofence, accuracy policy, server time),
shifts (including overnight) and assignments, history with append-only evidence, team and HR views, a
low-accuracy review queue, corrections through the request workflow or directly by HR with fresh MFA,
approved leave, remote work and missions applied from Phase 6 effects, a missing-checkout sweep, a bounded
CSV export and optional coordinate retention. Coordinates are never shown or exported. An administrator
must save the location accuracy policy before location check-ins are accepted (the development seed
saves one). `RATE_LIMIT_ATTENDANCE_PER_MINUTE` and `ATTENDANCE_SWEEP_INTERVAL_MS` are described in
`docs/DEPLOYMENT.md`. Design decisions are in ADR-0022.

Phase 8 adds the operational home (`/`: quick actions, Needs Attention, my numbers, attendance today,
reports due, my projects), role dashboards (`/dashboards/support`, `/dashboards/projects`,
`/dashboards/team`, `/dashboards/executive`) with trends, global search (Ctrl/Cmd+K), the administrator
setup checklist (`/admin/setup`) and notification preferences (`/notifications/preferences`). Every
number is computed in the viewer's scope and opens the list it counts; Jira and GitHub numbers come from
the local caches with their freshness; nothing ranks people. Dashboard numbers are cached in Redis for at
most 60 seconds and refreshed by events. `RATE_LIMIT_SEARCH_PER_MINUTE` is described in
`docs/DEPLOYMENT.md`. Design decisions are in ADR-0023.

Phase 9 adds custom roles (`/admin/roles`) and the production release:
- **Images:** `scripts/release/build-images.sh`.
- **Stack:** production Compose with a TLS proxy, production Keycloak realm, database roles and verified backups.
- **Signals:** Prometheus metrics and health checks.
- **Verification:** a smoke test (`scripts/release/smoke.ts`) and a rehearsal harness (`scripts/release/rehearse.ts`) that runs the whole production stack on a workstation.
- **Operations:** installation, upgrades, rollback, secrets, restore, Redis, Keycloak and monitoring are covered in [`docs/runbooks/`](docs/runbooks/), starting with [`deploy.md`](docs/runbooks/deploy.md).

Phase 10 adds tenders and contracts:
- **Tenders** (`/tenders`, `/tenders/my-work`): intake, bid/no-bid, a requirement compliance matrix with owners, reviewers and a readiness percentage, tender documents with versions, addenda and clarifications, internal review gates, submission with evidence, and award or loss.
- **Corporate Document Vault** (`/documents`): reusable company documents with versions, validity and expiry reminders, linked to tender requirements.
- **Contracts** (`/contracts`): created from an awarded tender or directly, linked to a project, with obligations (including monthly, quarterly or yearly recurrence), milestones, guarantees, amendments that update the current value and expiry while the original stays unchanged, renewal actions with notice deadlines, and a health status with its reasons.
- **Management:** the commercial dashboard (`/dashboards/commercial`), executive cards, Needs Attention items, global search, CSV reports, notifications and the project Commercial tab. Reminder thresholds are set in `/admin/commercial`.
- **Confidentiality:** financial values and confidential documents need their own permissions.

`COMMERCIAL_MONITOR_INTERVAL_MS` is described in `docs/DEPLOYMENT.md`. Design decisions are in ADR-0026.

For a real first organization instead of demo data, use the bootstrap CLI. It creates a single-use
invitation link for the first administrator (no passwords are created), printed only to an interactive
terminal, or written to a `0600` file with `--invitation-file <path>` (required in CI and whenever output
is captured; see `docs/runbooks/deploy.md`):

```bash
pnpm bootstrap --slug acme --name "Acme Ltd" --time-zone Africa/Cairo --work-week 7,1,2,3,4 --admin-name "Jane Admin"
```

If another PostgreSQL already listens on port 5432, set `POSTGRES_HOST_PORT` in `.env` and use the same port in
`DATABASE_URL` / `DATABASE_MIGRATION_URL`.

| URL | What |
|---|---|
| <http://localhost:3000> | Web shell |
| <http://localhost:4000/api/v1/health/live> · `/ready` | API liveness / readiness (PostgreSQL + Redis) |
| <http://localhost:4000/api/v1/docs> | OpenAPI UI (when `SWAGGER_ENABLED=true`) |
| <http://localhost:8080/admin> | Keycloak admin (bootstrap admin from `.env`) |
| <http://localhost:8025> | Mailpit |

Quality gates (also run in CI):

```bash
pnpm lint
pnpm typecheck
pnpm test               # unit tests
pnpm test:integration   # needs Docker and `pnpm infra:up` (SeaweedFS); starts PostgreSQL, Redis and Keycloak via Testcontainers
pnpm test:e2e           # builds web/API/worker, starts its own PostgreSQL, Redis and Keycloak containers and drives Chromium
pnpm build
pnpm format:check
```

Before the first `pnpm test:e2e`, install the browser once: `pnpm --filter @company-ops/e2e exec playwright install chromium`.
The E2E stack uses ports 3210 (web) and 4210 (API) and never touches the dev Compose stack. Failure traces
and screenshots go to `apps/e2e/test-results/`.

The CI workflow (`.github/workflows/ci.yml`) runs the same gates plus an OpenAPI drift check, `pnpm audit`,
gitleaks, CodeQL, production Compose validation, the release image build with the Trivy gate, and SBOMs. The repository has not been pushed yet, so it has not run on GitHub.

Stop the infrastructure with `pnpm infra:down` (volumes are kept).
#   c o m p a n y - o p e r a t i o n s  
 