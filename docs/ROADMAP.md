# Roadmap & Backlog

Each phase ends with the repository **runnable and testable**, all quality gates green (`lint`, `typecheck`, `test`, `test:integration`, `build`; `test:e2e` for implemented flows from Phase 1), and documentation updated. Every backlog item follows the Definition of Done in master spec §52 plus `SECURITY.md` §15.

Legend: **[M]** must-have for phase exit · **[S]** should-have · IDs per phase. Phase placements follow ADR-0011.

---

## Phase 0 — Architecture & specifications (approved)

- [x] P0-1 Specification review, contradictions & risks (`PRD.md` §10) + business baselines A–H (`PRD.md` §12)
- [x] P0-2 System architecture + API inventory (`ARCHITECTURE.md`)
- [x] P0-3 Domain/data model incl. composite tenant keys (`DATA_MODEL.md`)
- [x] P0-4 Permission model + V1 RBAC baseline + MFA (`SECURITY.md` §2–§3)
- [x] P0-5 Jira & GitHub integration strategy (`INTEGRATIONS.md`)
- [x] P0-6 Roadmap & backlog (this file)
- [x] P0-7 Deployment & backup plan (`DEPLOYMENT.md`)
- [x] P0-8 Dependency selection with sources and dates (`DEPENDENCIES.md`)
- [x] P0-9 ADRs 0001–0014 (`docs/adr/`)
- [x] P0-10 UI/UX specification (`UI_UX.md`)
- [x] P0-11 **Stakeholder approval of Phase 0** (explicit)

---

## Local environment prerequisites (before Phase 1 work)

This is environment setup, **not** Phase 1 implementation. Nothing here is executed until Phase 0 is approved. Current machine state (observed 2026-10-02): Node 20.18.1 (EOL), no pnpm, npm cache configured at `D:\npm-cache` and failing (`npm view` returned empty / `ENOENT`), Docker 26.1.1, Compose v2.27.0, Git present, `gh` CLI authenticated.

| Step | Action | Source |
|---|---|---|
| E1 | Install **Node.js 24.21.0 (24 LTS)** using the official Windows installer from nodejs.org (or a Node version manager that installs official builds). Verify `node -v` → `v24.21.0`. | nodejs.org/dist index; ADR-0007 |
| E2 | Repair the npm cache: run `npm config get cache`; if it reports `D:\npm-cache`, either make sure the `D:` volume exists and the folder is writable, or remove the override with `npm config delete cache` (falls back to npm's default cache location). Then run `npm cache verify`. Confirm `npm view prisma version` returns a version. | npm CLI docs (`npm config`, `npm cache`) |
| E3 | Install **pnpm 12.8.1** via the official pnpm installation path. On Windows, pnpm.io recommends `npx get-pnpm` (requires Node ≥ 22.13 — satisfied by E1). Verify `pnpm -v` → `12.8.1`. **Do not rely on Corepack.** | pnpm.io/installation (checked 2026-10-02) |
| E4 | Confirm Docker Engine + Compose v2 running (`docker version`, `docker compose version`) and that images in `DEPENDENCIES.md` §6 can be pulled. | — |
| E5 | Record results (versions) in the Phase 1 kickoff notes. | — |

## Phase 1 — Entry criteria (all must hold before any Phase 1 work starts)

Entry criteria gate the **start** of Phase 1; exit criteria (below) gate its **completion**.

| # | Entry criterion |
|---|---|
| EN-1 | Explicit stakeholder approval of Phase 0 (P0-11) |
| EN-2 | No open architecture contradictions across `docs/` (final remediation report) |
| EN-3 | Every dependency in `DEPENDENCIES.md` verified from an official source with date; no NOT VERIFIED items |
| EN-4 | ADRs exist for every material deviation from the master spec (ADR index) |
| EN-5 | Business baselines A–H recorded (`PRD.md` §12); remaining stakeholder questions are non-blocking |
| EN-6 | Security baseline accepted: RBAC baseline, MFA list, tenancy checklist (`SECURITY.md`) |
| EN-7 | Local environment prerequisites E1–E4 completed and verified |
| EN-8 | Phase 1 scope confirmed as foundations only (below) |

## Phase 1 — Foundation

**Exit criteria**: authentication works end-to-end against Keycloak, including MFA step-up for privileged actions · tenant isolation negative tests pass (read, list, create-relationship, update-relationship, composite-FK constraint) · RBAC baseline enforced · web/API/worker builds pass · migrations apply on a clean DB · dev infrastructure starts with Docker Compose · CI green.

| ID | Item | Pri |
|---|---|---|
| P1-1 | Monorepo: pnpm workspace, Turborepo, shared strict tsconfig (ESM, `nodenext`), flat ESLint 10 configs, Prettier, `.nvmrc` 24, `packageManager` pin, minimum-release-age setting (confirm pnpm 12 setting name) | M |
| P1-2 | Dev Compose (`infra/compose/docker-compose.dev.yml`): PostgreSQL 18.6, Redis 8.10.2, Keycloak 26.8.0 (realm import: `company-ops`, client `ops-api`, ACR→LoA mapping + step-up flow, demo users), SeaweedFS 4.48 (S3), Mailpit v1.31.3; images pinned by digest; healthchecks | M |
| P1-3 | `packages/db`: Prisma 7.10.0 schema — organizations, users, organization members, employee profiles, departments, job titles, teams, roles, role permissions, member roles, counters, audit logs, platform audit logs, attachments, notifications, outbox; `UNIQUE (organization_id, id)` + composite FKs; extensions (`citext`, `pg_trgm`, `btree_gist`); initial migration | M |
| P1-4 | Dev-only seed (`NODE_ENV !== 'production'` **and** `ALLOW_DEMO_SEED=true`): demo org with time zone `Africa/Cairo` and work week Sunday–Thursday **as seed data only**, departments, ~30 employees, role grants matching Keycloak demo users | M |
| P1-5 | CLI bootstrap command: create first organization + first ORG_ADMIN membership, materialize system roles, write `platform_audit_logs` (ADR-0010) | M |
| P1-6 | `packages/shared`: permission catalog, scopes, system role templates (§2.5 baseline), `PRIVILEGED_PERMISSIONS`, error codes, enums | M |
| P1-7 | `packages/validation`: Zod schemas for Phase 1 endpoints; Nest Standard Schema wiring; OpenAPI output check (ADR-0004) | M |
| P1-8 | API bootstrap: env validation, pino + redaction, request ID, helmet, CORS, exception filter + envelope, throttler (Redis), OpenAPI at `/api/v1/docs` (non-prod), health/ready | M |
| P1-9 | Auth: OIDC login/callback/logout/back-channel logout, Redis sessions, CSRF, MFA step-up (`MfaGuard`, `401 MFA_REQUIRED`, `acr_values=mfa`), `GET /api/v1/me` | M |
| P1-10 | Tenancy: CLS tenant context, tenant-scoped repository base, Prisma guard extension, raw-SQL module + lint ban on unsafe raw methods | M |
| P1-11 | Authorization: `PermissionGuard`, policy service with scope evaluation + list scope filters; unit tests per scope and per baseline role | M |
| P1-12 | Organizations & people APIs: org settings (time zone, work week required — no defaults), employees, departments, teams, job titles, role grants (audited, MFA) | M |
| P1-13 | Audit service (append-only, redaction) + `GET /api/v1/audit/events` | M |
| P1-14 | Attachments foundation: `StoragePort` + S3 adapter, upload intents, confirm, authorized download, MIME sniffing, tenant tests (first consumer: employee avatar) | M |
| P1-15 | Notification **foundation**: outbox + relay, in-app notifications persistence + list/read API, minimal bell UI. (No email, no SSE, no preferences — ADR-0011) | M |
| P1-16 | Worker app: BullMQ module, queue registry, outbox relay processor, tenant-context job wrapper, failed-job admin API | M |
| P1-17 | Web shell: Next.js 16, Tailwind 4, shadcn/ui in `packages/ui`, next-intl (en + ar skeleton, RTL), app shell per `UI_UX.md`, login/unauthorized/session-expired/MFA-required states, `/me`-driven nav, profile, employees & departments screens, notifications bell, PWA manifest | M |
| P1-18 | `packages/api-client`: OpenAPI-generated types + openapi-fetch client; CI staleness check | M |
| P1-19 | Tests: unit (permissions/policy), integration with Testcontainers PostgreSQL (tenancy negative suite, RBAC, composite-FK constraint tests, migrations from zero), Playwright login + MFA step-up + cross-tenant rejection + axe on shell | M |
| P1-20 | CI (GitHub Actions, actions pinned by SHA): frozen install, lint, typecheck, unit, integration, build, OpenAPI drift, e2e, `pnpm audit`, gitleaks CLI, CodeQL | M |

**Status: all Phase 1 items are implemented and verified locally (2026-10-02); approved.** Phase 1A and 1B were approved earlier; the remainder was delivered in one pass.

| ID | Status | Notes |
|---|---|---|
| P1-1 | Done | pnpm 12.8.1 workspace, Turborepo, strict TS 6, ESLint 10 flat configs, Prettier, `minimumReleaseAge` |
| P1-2 | Done | Dev Compose with digest-pinned images, health checks, realm import (LoA step-up, demo users) |
| P1-3 | Done | Two migrations: identity/tenancy and people/attachments/notifications/outbox; composite tenant FKs, CHECKs, audit grants and triggers (`DATA_MODEL.md` §0). Extensions are deliberately not installed until a column uses them (documented deviation) |
| P1-4 | Done | Guarded idempotent seed: demo organization (Africa/Cairo, Sunday–Thursday), second organization for the multi-org account, departments, teams, job titles, ~30 employees, role grants |
| P1-5 | Done | `pnpm bootstrap`: organization + system roles + invited ORG_ADMIN (no passwords), platform audit, idempotent, `--confirm-production` in production |
| P1-6 | Done | Permission catalog, scopes, system role templates, privileged list, error codes |
| P1-7 | Done | Zod request/response schemas for every endpoint, Standard Schema pipe, OpenAPI from the same schemas |
| P1-8 | Done | Env validation, pino with redaction (tested), request ids, helmet, CORS, error envelope, Redis throttler, OpenAPI (non-prod), health/ready |
| P1-9 | Done | OIDC login/callback/step-up/logout/back-channel logout, Redis sessions, CSRF, MFA, `/me`, org switch; no token refresh (ADR-0002 amendment) |
| P1-10 | Done | CLS tenant context, guard extension, tenant-scoped data access, raw-SQL lint ban + runtime guard |
| P1-11 | Done | SELF/TEAM/DEPARTMENT/ORG scopes (recursive department tree), list scope filters, mutation checks; PROJECT scope fails closed until Phase 2 |
| P1-12 | Done | Org settings, employees (create/invite/edit/disable/avatar), departments, teams + members, job titles, role grant/revoke with MFA, escalation rules, last-admin protection |
| P1-13 | Done | Append-only audit + `GET /audit/events` (cursor, filters) and `GET /audit/events/:id` with `audit.view` |
| P1-14 | Done | `StoragePort` + S3 adapter, upload intents, completion with size/MIME sniff/SHA-256, authorized download URLs, expiry job, avatar consumer (API; the browser upload widget comes with the first attachment UI in P2-6) |
| P1-15 | Done | Transactional outbox, notifications persistence with dedupe, list/read/unread API, bell UI. No email, SSE or preferences (ADR-0011) |
| P1-16 | Done | Worker with BullMQ queues, outbox relay (`SKIP LOCKED`, deterministic job ids), tenant-bound processors, retries/permanent failures, `GET /admin/failed-jobs` + admin screen |
| P1-17 | Done | Next.js 16 shell per `UI_UX.md`: sidebar/rail/bottom navigation, session states (signed out, expired, MFA required, forbidden), org switcher, profile, people/departments/teams/admin/audit/jobs screens, notifications, en + ar (RTL), PWA manifest |
| P1-18 | Done | Generated types + `openapi-fetch` client; CI drift check |
| P1-19 | Done | Unit, Testcontainers integration (tenancy, RBAC, composite FKs, migrations from zero, OIDC against real Keycloak, rate limits, outbox) and 19 Playwright tests (login, MFA step-up, org switch, cross-tenant 404, permissions, axe at 375/768/1024/1440, RTL) |
| P1-20 | Done locally | Workflow defines frozen install, format, lint, typecheck, unit, integration, e2e, build, OpenAPI drift, `pnpm audit`, gitleaks and CodeQL with SHA-pinned actions. The repository has not been pushed, so it has **not run on GitHub yet**; the exit criterion "CI green" is met by running the same commands locally |

Explicitly **not** in Phase 1: email channel and SSE (Phase 3), Jira (4), GitHub (5), requests/approvals (6), attendance (7), dashboards, global search, setup checklist UI, notification preferences (8).

## Phase 2 — Projects

**Exit**: a PM can create/view a project, assign people, and see project operational information.

| ID | Item | Pri |
|---|---|---|
| P2-1 | Customers CRUD | M |
| P2-2 | Projects CRUD, status/health with reason (audited), code/number | M |
| P2-3 | Project members & project roles; "my projects" | M |
| P2-4 | Work locations (shared with attendance) + project locations | M |
| P2-5 | Project detail page with tabs (Overview, Team, Support*, Jira*, GitHub*, Daily Reports, Activity, Settings) — *honest empty states until their phase | M |
| P2-6 | Daily reports: submit (mobile-first, attachments), list, detail; policy; missing-report computation + job. Includes the browser attachment upload widget (CSP `connect-src`/`img-src` for the S3 public endpoint, bucket CORS), reused for employee avatars | M |
| P2-7 | Project activity read model fed by outbox consumers | M |

**Status: all Phase 2 items are implemented and verified locally (2026-10-03); approved.** Decisions are recorded in ADR-0017.

| ID | Status | Notes |
|---|---|---|
| P2-1 | Done | Customers: list (archived filter), create, edit, archive/unarchive; audited; unique name per organization |
| P2-2 | Done | Projects: server-side list (cursor pagination, allow-listed filters and sorts), create, detail, edit, status lifecycle with reason, manual health with note, archive/restore, optimistic concurrency (`version`), counter-based numbers and default codes, audit, PM/TM notifications via the outbox |
| P2-3 | Done | Membership: add, change role, remove, list; escalation rules for project-scoped assigners; PROJECT scope (reach) in the policy engine and list filters; "my projects" filter and employee project card |
| P2-4 | Done | Work locations (admin screen, `attendance.config`) and project location links; reusable by attendance (P7) |
| P2-5 | Done | Detail tabs Overview, Team, Daily reports, Activity, Settings; Support, Jira and GitHub shown as disabled tabs with no data |
| P2-6 | Done | Daily reports: mobile-first submit form, list with filters, detail; policy editor; derived missing reports (project time zone) and the `daily-report.missing.check` job with deduplicated notifications; browser upload widget (progress, errors, verification, authorized download and delete) reused for employee photos; CSP `connect-src`/`img-src` for `STORAGE_PUBLIC_ORIGIN`; object deletion through the outbox |
| P2-7 | Done | `project_activity` written by the `projects` queue consumer from `project.activity.recorded` events (idempotent), localized timeline UI, rebuild command `pnpm activity:rebuild` |

Explicitly **not** in Phase 2: global search (P8-6), task/issue tracking, support team assignment (Phase 3), report editing (ADR-0017).

## Phase 3 — Support

**Exit**: a field employee can report a problem and Support can manage it end-to-end.

| ID | Item | Pri |
|---|---|---|
| P3-1 | Categories, components (config UI) | M |
| P3-2 | Ticket create (mobile-first with photo), list (inbox, mine, critical; cards on mobile), detail | M |
| P3-3 | Ticket state machine + transitions API, optimistic locking | M |
| P3-4 | Assignment, watchers, comments, internal notes, attachments | M |
| P3-5 | Append-only ticket events + timeline UI | M |
| P3-6 | SLA policies, due dates incl. pause statuses + optional business calendar | M |
| P3-7 | SLA sweep job (per-org iteration), AT_RISK/BREACHED, `sla_events` uniqueness | M |
| P3-8 | Escalation rules + multi-level notifications | M |
| P3-9 | Email channel: `EmailChannel` port, SMTP adapter, Mailpit in dev, localized templates | M |
| P3-10 | Real-time: SSE endpoint + Redis pub/sub (org-scoped channels) for critical tickets and assignments | M |
| P3-11 | Project Support tab + overview counters | M |

**Status: all Phase 3 items are implemented and verified locally (2026-10-03); approved.** Decisions are recorded in ADR-0018.

| ID | Status | Notes |
|---|---|---|
| P3-1 | Done | Categories and components (global or project-scoped) on the Support settings screen (`support.config`); audited; unique names per organization; scoped component lists |
| P3-2 | Done | Mobile-first create form with photo/file attachments and idempotent submission; queue views (open, assigned to me, reported by me, watching, unassigned, untriaged, critical, SLA risk, all) with allow-listed filters, sorts and cursor pagination; cards below `md`, table above; detail page |
| P3-3 | Done | Pure state machine; `POST /support/tickets/{id}/transitions` with `version`; resolve, verify and close are separate steps; no auto-close; reasons and resolution notes |
| P3-4 | Done | Team and assignee (active, eligible members only; audited); watchers (visibility required); public comments and internal notes (never leaked to reporters, notifications, email or history); ticket attachments with authorized download |
| P3-5 | Done | `support_ticket_events` with append-only triggers; localized timeline on the ticket page |
| P3-6 | Done | SLA policies (match order, first response and resolution targets, at-risk threshold, pause statuses) and business calendars (working hours, holidays, DST-correct time zones) |
| P3-7 | Done | `sla.sweep` worker job per organization; ON_TRACK/AT_RISK/BREACHED/PAUSED/MET; sticky breaches; once-only `sla_events` via a partial unique index |
| P3-8 | Done | Escalation rules (levels 1–5; elapsed %, unresolved minutes, first response breached) notifying roles, project roles and members once per level |
| P3-9 | Done | `EmailChannel` port with the nodemailer SMTP adapter, Mailpit in development and e2e, localized HTML-escaped templates, `notification_deliveries` tracking, retries and dedupe |
| P3-10 | Done | SSE `GET /notifications/events/stream` over tenant-scoped Redis channels; IDs-only payloads; the web app invalidates queries and shows the bell count live |
| P3-11 | Done | Project Support tab: open, critical and SLA-risk counts plus counts per status (all scoped to the caller), the open-ticket queue, the support team setting; no per-person metrics |

Explicitly **not** in Phase 3: Jira or GitHub links (WAITING_FOR_DEVELOPMENT is a plain status), customer portal, Markdown rendering, notification preferences (P8), global search (P8-6).

## Phase 4 — Jira

**Exit**: historical Jira issues import safely; later changes synchronize automatically.

| ID | Item | Pri |
|---|---|---|
| P4-0 | Spike: validate OAuth 3LO, webhook JWT claims, search/jql + approximate-count against a test site; update `INTEGRATIONS.md` | M |
| P4-1 | Token encryption service (AES-256-GCM, key rotation) | M |
| P4-2 | Connect flow, site selection, connection status, re-auth | M |
| P4-3 | Project mappings UI/API (audited) | M |
| P4-4 | Historical import runs: page jobs, checkpointing, progress via SSE, cancel, restart | M |
| P4-5 | Webhook registration/refresh, intake (JWT verify, dedupe), processor | M |
| P4-6 | Reconciliation jobs (hourly, weekly deep) | M |
| P4-7 | Ticket ↔ Jira: search, link, create, unlink; status sync events | M |
| P4-8 | Project Jira tab: open/blocked/overdue, recent changes | M |
| P4-9 | Sync history & failures admin screen | M |
| P4-10 | Adapter tests (pagination, resume, duplicates, replay, out-of-order, 429, invalid_grant) | M |

**Status: P4-1…P4-10 are implemented and verified locally against the deterministic Jira test double (2026-10-03); approved, with live Jira validation accepted as a deferred production-readiness check. P4-0 is done as a documentation spike only: no live Jira test site was available, so no operation has been exercised against real Jira Cloud.** Decisions are recorded in ADR-0019; the as-built contract is `INTEGRATIONS.md` §1.9.

| ID | Status | Notes |
|---|---|---|
| P4-0 | Partly done (live part open) | Every Atlassian contract re-verified from official documentation on 2026-10-03 and recorded in `INTEGRATIONS.md` §1.9.1 (OAuth 3LO + rotation, `search/jql` with `nextPageToken`, `approximate-count`, `bulkfetch`, `createmeta/{project}/issuetypes`, dynamic webhooks, HS256 webhook JWT). **Not validated against a live site**; the checklist is DEPLOYMENT §6 |
| P4-1 | Done | AES-256-GCM envelopes with AAD per organization, connection and field; key rotation through `APP_ENCRYPTION_KEYS_PREVIOUS`; refresh under a per-connection lock with rotated refresh tokens stored atomically |
| P4-2 | Done | Connect, consent, site selection (single-use grant), status, reauthorize, disconnect with asynchronous cleanup; `NEEDS_REAUTH` with admin notifications; MFA-gated `integration.manage` |
| P4-3 | Done | Admin screen and API for mappings (a Jira project maps to exactly one internal project; a project may have several Jira projects), blocked statuses, sync on/off, removal; audited; optimistic versions |
| P4-4 | Done | Bounded slice jobs, timestamp + row-id checkpoints, live progress (SSE hint + bar), cancel, retry from checkpoint, stale-run watchdog |
| P4-5 | Done | One webhook per connection, register-before-delete, 30-day refresh; JWT verification, connection and webhook-id binding, per-connection delivery dedupe; processor re-fetches issues |
| P4-6 | Done | Incremental reconciliation (default hourly) and deep reconciliation (default weekly: tombstones, count drift → full re-sync) |
| P4-7 | Done | Ticket Development panel: cache and live search, link/unlink with link types, idempotent issue creation (no internal notes), `JIRA_STATUS_SYNCED` history and notifications; ticket status never changed automatically |
| P4-8 | Done | Project Jira tab: open, by category, blocked, overdue, linked tickets, recently updated issues with deep links; no per-person metrics |
| P4-9 | Done | Sync history with filters, run detail with failures, failed webhook deliveries, retry/cancel |
| P4-10 | Done | Unit and integration suites against the test double: pagination, resume, duplicates, replay, out-of-order, 429/`Retry-After`, `invalid_grant`, refresh races, tenant isolation; API and Playwright suites cover the 17 Phase 4 browser flows |

Explicitly **not** in Phase 4: GitHub (Phase 5), Jira comments/sprints/boards, writing ticket data to Jira other than an explicit create, automatic ticket status changes, retention pruning of webhook deliveries and sync failures.

## Phase 5 — GitHub

**Exit**: managers see GitHub development signals without using our platform as a code host.

| ID | Item | Pri |
|---|---|---|
| P5-1 | App manifest + installation flow with signed state | M |
| P5-2 | Repository sync & mappings UI | M |
| P5-3 | Webhook intake (HMAC verify, delivery dedupe) + processors | M |
| P5-4 | PR/review/check state computation, reconciliation | M |
| P5-5 | Jira key inference + manual linking/confirmation | M |
| P5-6 | Project GitHub tab; ticket view PRs (direct + via Jira) | M |
| P5-7 | Adapter tests (signature, duplicates, forged installation id) | M |

**Status: P5-1…P5-7 are implemented and verified locally against the deterministic GitHub test double (2026-10-03); approved, with live GitHub validation pending credentials. No GitHub App or test organization was available, so no operation has been exercised against GitHub.com (checklist: DEPLOYMENT §6).** Decisions are recorded in ADR-0020; the as-built contract is `INTEGRATIONS.md` §2.6.

| ID | Status | Notes |
|---|---|---|
| P5-1 | Done | Manifest template (read-only Metadata, Pull requests, Checks, Commit statuses; Contents none); session-bound single-use state, GitHub user authorization proving access to the installation (token revoked), App JWT confirmation, one organization per installation; MFA-gated `integration.manage`; audited |
| P5-2 | Done | Repository discovery keyed by immutable id (renames, removal, deletion keep history); many-to-many project mappings with soft removal; admin screen with installation state, permissions, repositories, mappings, sync runs, failures and deliveries |
| P5-3 | Done | Raw-body HMAC-SHA256 verification (no SHA-1), body cap, header/payload validation, `X-GitHub-Delivery` dedupe, tenant from the stored binding only, outbox-queued processing that re-fetches from GitHub, coalesced refreshes |
| P5-4 | Done | Review and check summaries per head commit with out-of-order guards; initial sync (open + 90 days), 30-minute reconciliation, manual re-sync, stale-run watchdog, installation-wide rate-limit pause |
| P5-5 | Done | Key inference from branch, title and capped body; confirmation only for cached issues of Jira projects mapped to the same project, otherwise suggestion; manual link/confirm/dismiss, audited |
| P5-6 | Done | Project GitHub tab (signals without per-person metrics) and ticket pull-request panel (via Jira links and direct links, same-project repositories only) |
| P5-7 | Done | Unit, core/API/worker integration and Playwright suites against `FakeGithub`: signatures, duplicates, replays, forged installation ids, cross-tenant references, rate limits, suspension and removal; 17 browser flows with axe at four widths |
| Carry-forward | Done | Retention of technical integration records (webhook deliveries, sync failures) per explicit organization policy through a bounded purge function; audit history and business links are never purged |

Explicitly **not** in Phase 5: writing to GitHub (comments, statuses, merges), source code, diffs or file contents, developer metrics or rankings, GitHub Enterprise Server, live validation against GitHub.com and Jira Cloud (pending credentials).

## Phase 6 — Requests & approvals

**Exit**: an employee submits a request and the correct approver(s) approve through a traceable workflow.

| ID | Item | Pri |
|---|---|---|
| P6-1 | Request types + form schema DSL + dynamic form renderer | M |
| P6-2 | Workflow definitions, versions (immutable once published), steps, approver rules, conditions | M |
| P6-3 | Workflow engine (pure, unit-tested) | M |
| P6-4 | Submission (pins version), my requests, detail with history | M |
| P6-5 | **Needs My Approval** inbox (mobile approve/reject), delegation | M |
| P6-6 | Fulfillment steps | M |
| P6-7 | Seeded request types (dev seed) | M |
| P6-8 | Effects: approved Leave/WFH/Mission → `request.approved` event for attendance | M |
| P6-9 | Approval SLA reminders (deduplicated) | S |

**Status: P6-1…P6-9 are implemented and verified locally (2026-10-04); awaiting review.** Decisions are recorded in ADR-0021; the physical schema is `DATA_MODEL.md` "Phase 6 — Requests".

| ID | Status | Notes |
|---|---|---|
| P6-1 | Done | Request types with localized names, category, icon, eligibility roles and active flag; bounded form DSL (13 field types, conditional visibility, attachment policy) validated by a Zod meta-schema; dynamic renderer with client and server validation, RTL |
| P6-2 | Done | One definition per type; DRAFT/PUBLISHED/RETIRED versions, at most one draft and one published (partial unique indexes); database triggers make published versions and their steps immutable; approver rules: direct manager, department manager, team lead, project manager, technical manager, role, member; flat ANY/ALL condition groups; admin builder with version list and publish |
| P6-3 | Done | Pure engine (form validation, conditions, route planning, approver selection, ANY_ONE/ALL decisions) with unit tests; never approves without a human decision; never assigns the requester |
| P6-4 | Done | Transactional, idempotent submission (`Idempotency-Key`), `REQ-n` numbers, pinned version and stored route, approver preflight, approvers frozen at step activation; My requests, request detail with append-only history and attachments |
| P6-5 | Done | My approvals inbox (mobile approve/reject, mandatory rejection reason), row-locked decisions with idempotent retries and `409` on conflicts; delegation with period, type scope, no self/cycle/transitivity, audit and notification; administrator reassignment |
| P6-6 | Done | Fulfillment steps performed in order by `request.fulfill` holders other than the requester |
| P6-7 | Done | Dev seed: Leave, Work from home, Laptop, Software access, Purchase, Business mission (conditional routes) |
| P6-8 | Done | `request_effects` + outbox event `request.approved` (and `request.effect.revoked`) consumed by a worker that only acknowledges until Phase 7; no attendance data is created |
| P6-9 | Done | Worker SLA sweep (`REQUEST_SLA_SWEEP_INTERVAL_MS`) sends one overdue reminder per assignment (and to active delegates) |
| Tests | Done | Engine unit tests; core, API and worker integration suites (tenant isolation, authorization, concurrency, idempotency, immutability, notifications and email re-check); 20 Playwright scenarios plus builder, axe and responsive checks at 375/768/1024/1440 |

Explicitly **not** in Phase 6: attendance records (Phase 7), requests on behalf of others, free-form request comments, bulk approvals, inventory/procurement/payroll, nested condition groups.

## Phase 7 — Attendance

**Exit**: authorized employees check in/out from valid locations; managers view attendance appropriately.

| ID | Item | Pri |
|---|---|---|
| P7-1 | Shifts + assignments (no overlaps) | M |
| P7-2 | Check-in/out API: idempotency key, server time, haversine, accuracy always stored, org `maxAccuracyMeters` + `lowAccuracyAction` (`SECURITY.md` §9), evidence events | M |
| P7-3 | Mobile check-in UX (permission prompts, accuracy feedback, transparent messaging, retry) | M |
| P7-4 | Late / early-leave in the org's configured TZ; missing checkout job | M |
| P7-5 | Remote / leave / mission from approved requests | M |
| P7-6 | My history, team view, HR view, low-accuracy review queue, export | M |
| P7-7 | Correction requests + approval (evidence preserved) | M |
| P7-8 | `retention_policies` table + admin UI (MFA) + `retention.purge` that runs **only** for explicitly configured categories, with dry-run count | S |

**Status: P7-1…P7-8 are implemented and verified locally (2026-10-04); awaiting review.** Decisions are recorded in ADR-0022; the physical schema is `DATA_MODEL.md` "Phase 7 — Attendance". Browser geolocation can be spoofed: attendance evidence supports dispute resolution and is not fraud-proof.

| ID | Status | Notes |
|---|---|---|
| P7-1 | Done | Shifts (overnight, graces, ISO weekdays, deactivate-only, versioned) and assignments (start today or later, end no earlier than yesterday, GiST exclusion against overlaps); admin screen with `attendance.config`; records snapshot the shift |
| P7-2 | Done | `POST /api/v1/attendance/check-in` / `check-out` with mandatory `Idempotency-Key`, server time, server-side haversine against server-computed eligible locations (no client location id), low accuracy never `INSIDE`, per-employee advisory lock, append-only evidence (trigger-protected) and derived records; organization accuracy policy (fresh MFA, audited, no hidden default) |
| P7-3 | Done | Today screen: one foreground position read per tap, privacy notice, permission/unavailable/timeout/insecure/stale messages, low-accuracy warning with "Try again" / "Send this reading" (worded as a server-side policy check, Phase 8 consistency review), no automatic retries, idempotent manual retry; large touch action on phones; Attendance in the mobile bottom bar |
| P7-4 | Done | Late and early-leave minutes from the shift snapshot in the employee's zone (DST-safe, overnight shifts); `attendance` queue sweep (`ATTENDANCE_SWEEP_INTERVAL_MS`, bounded, idempotent) flags missing check-outs without inventing a time, one in-app notice |
| P7-5 | Done | Phase 6 `request_effects` consumed: leave blocks check-in, remote work and missions need no location, short permissions excuse late/early windows; materialization and revocation are idempotent events |
| P7-6 | Done | My history (paginated), team day view and records (scope from the policy engine, no payroll), HR organization view with review queue and direct corrections, CSV export (≤ 62 days, ≤ 10 000 rows, formula-safe, no coordinates, audited) |
| P7-7 | Done | Employee corrections with five reason codes become requests of the reserved `attendance_correction` type (Phase 6 engine, direct manager); applied and reverted as new events; administrator corrections need fresh MFA, a reason and a note |
| P7-8 | Done | `ATTENDANCE_COORDINATES` retention (≥ 30 days, MFA, audited, preview) nulls coordinates in bounded batches through a SECURITY DEFINER function; records and audit logs are never purged |
| Tests | Done | Engine unit tests (geofence, time zones, DST gaps/overlaps, overnight, derivation); core, API and worker integration suites (idempotency, races, forged ids, scopes, append-only triggers, composite tenant keys, effects, corrections, sweep, export, retention, rate limits); 22 Playwright flows with mocked geolocation plus axe and layout checks at 375/768/1024/1440 and RTL |

Explicitly **not** in Phase 7: background or continuous location, payroll/overtime pay, biometric or device attestation, offline check-in, background exports, the management dashboard (Phase 8).

## Phase 8 — Dashboards & cross-module features

**Exit**: role dashboards show real, linked data; GM can answer "what needs attention now".

| ID | Item | Pri |
|---|---|---|
| P8-1 | Dashboard read services per module (counts with filter descriptors mapping to list URLs) | M |
| P8-2 | Needs Attention feed (rule-based prioritization) | M |
| P8-3 | Employee / Field / Support / PM / GM / HR / Technical dashboards; mobile employee home | M |
| P8-4 | Redis caching (org + scope keyed) + event invalidation | S |
| P8-5 | Trend charts where meaningful | S |
| P8-6 | Global search (tsvector + pg_trgm) across permitted entities | M |
| P8-7 | First-run setup checklist UI (flags exist since Phase 1) | S |
| P8-8 | Notification preferences UI | S |

**Status: P8-1…P8-8 are implemented and verified locally (2026-10-04); awaiting review.** Decisions are recorded in ADR-0023; metric definitions are `ARCHITECTURE.md` §11e. No ranking, leaderboard or per-person count exists anywhere.

| ID | Status | Notes |
|---|---|---|
| P8-1 | Done | Read-only services in `packages/core/src/modules/dashboard/`; every number is `{ value, link }` and is counted with the same `where` builder and filter object as the list its link opens (tickets, projects, requests, approvals, attendance day buckets); list screens start from the linked filters, read through the router so they also apply after client-side navigation (the ticket and project lists also name filters that have no visible control) |
| P8-2 | Done | Deterministic rules (SLA breached / at risk, critical unassigned, project critical / at risk, approval overdue / waiting, own missing check-out, attendance reviews, own daily report due, requests awaiting fulfillment, Jira/GitHub problem for administrators); ordered by severity, then waiting time, then a stable key; one item per source entity; capped at 50 with a "more exist" flag |
| P8-3 | Done | Operational home for everyone (quick actions, Needs Attention, own numbers, attendance today, reports due, own projects, insights links, setup progress for administrators) stacked as cards on phones; support, projects (PM / department / technical), team (lead / department / HR) and executive dashboards, each gated by its permission and computed from the caller's server-resolved scope |
| P8-4 | Done | Redis keys `dash:v1:{org}:{dashboard}:{scopeHash}:{versionsHash}`; authorization runs before every read; per-organization domain counters bumped by the worker from outbox events (`dashboard.changed`, ticket/request/project/attendance events, Jira and GitHub syncs); TTL 60 s fallback; any Redis error or timeout falls back to the source queries |
| P8-5 | Done | Support created vs resolved and attendance check-ins per day; today / 7 / 30 / 90 days in the organization zone, zero-filled, bounded; every chart has a text summary and a values table |
| P8-6 | Done | PostgreSQL `ILIKE` with escaped wildcards on pg_trgm GIN indexes (deviation from tsvector, ADR-0023) over projects, employees, tickets, requests and cached Jira issues; authorization in each entity's `where`; 2–100 characters, ≤ 10 per type, cursor paging bound to the query, per-user rate limit `RATE_LIMIT_SEARCH_PER_MINUTE`; palette with Ctrl/Cmd+K, arrow keys, Enter and Escape, an icon in the phone header |
| P8-7 | Done | `GET /organization/setup-checklist` derives every item from real state on each request (nothing stored; `organizations.setup_state` stays unused); administrators only; Jira and GitHub optional |
| P8-8 | Done | `notification_preferences` per member, category and channel (in-app, email); ACCESS, in-app INTEGRATIONS and every CRITICAL notification locked on; muted in-app notifications are stored as read; the email worker re-checks the preference at send time and skips the delivery |
| Tests | Done | Unit tests for ranges, ordering, deduplication, scope hashing, LIKE escaping and links; core integration (count = linked list length for every role, scope isolation, tenant isolation, cache keys and fallback, search authorization and bounds, checklist, preferences and the worker re-check); API contracts, 401/403, validation, CSRF and the search rate limit; worker invalidation jobs; 22 Playwright scenarios plus axe and layout at 375/768/1024/1440 and RTL |

Explicitly **not** in Phase 8: BI warehouse, free date ranges, scheduled reports, per-person productivity metrics, GitHub pull requests in search, Teams/Slack/Push channels, read replicas.

## Phase 9 — Production hardening

| ID | Item | Pri |
|---|---|---|
| P9-1 | Full E2E suite (spec §35 scenarios) at 375/768/1024/1440 | M |
| P9-2 | axe checks across flows; keyboard audit; RTL visual pass | M |
| P9-3 | Security review (ASVS L2), DB role separation + grants, CSP tightening, rate-limit tuning | M |
| P9-4 | Dependency audit, Trivy image scans, SBOM | M |
| P9-5 | Production compose, Nginx TLS, backups & restore drill, monitoring (Sentry opt-in; OpenTelemetry evaluation) | M |
| P9-6 | Failure-recovery runbooks | M |
| P9-7 | Evaluate PostgreSQL RLS (ADR-0003 follow-up) | S |
| P9-8 | Custom roles UI | S |

**Status: P9-1…P9-8 are implemented and verified locally (2026-10-04).** This is the final V1 phase. Operations are documented in `docs/runbooks/`, and the security review is `SECURITY.md` §15i.

| ID | Status | Notes |
|---|---|---|
| P9-1 | Done | 15 Playwright spec files, including custom roles (`14-roles.spec.ts`). Every module spec (projects through roles) checks horizontal overflow at 375/768/1024/1440 and its screens in Arabic (RTL); `04` and `05` cover the shell. A production-stack journey (`apps/e2e/rehearsal/`) runs against the real images, proxy and production realm |
| P9-2 | Done | axe checks at 87 places in the specs (many inside width loops) across the module screens and their dialogs (`04`, `05`, `07`–`14`); keyboard paths tested in dialogs, the search palette and navigation |
| P9-3 | Done | ASVS 5.0 L2 chapter review (`SECURITY.md` §15i). Separate `ops_migrator` / `ops_app` / `ops_backup` / `keycloak` roles with 19 privilege tests. Central log redaction, `*_FILE` for every secret, production configuration refusals, and an edge rate-limit layer with measured thresholds. Nonce CSP for scripts; inline styles are an accepted risk |
| P9-4 | Done | `pnpm audit` gate with expiring exceptions (ADR-0015); Trivy gate on fixable HIGH/CRITICAL, CycloneDX SBOMs, report-only scan of third-party images; gitleaks |
| P9-5 | Done | One Dockerfile with four targets; production Compose with opt-in overlays; nginx TLS proxy; production Keycloak realm; verified backups with a restore drill and a production restore rehearsal; Prometheus metrics, health and SLOs (ADR-0024). Sentry and OpenTelemetry are evaluated and not included (no vendor SDK in V1) |
| P9-6 | Done | Runbooks for deploy, upgrade, rollback, secrets, backup and restore, Keycloak, TLS, Redis, database roles, observability and performance. Each recovery path was rehearsed on the production Compose stack |
| P9-7 | Done | RLS evaluated and not enabled in V1, with compensating controls (ADR-0025) |
| P9-8 | Done | `/admin/roles`: create, edit, delete custom roles and edit system-role grants, with escalation rules (`SECURITY.md` §15i) |

**Pre-production external blockers** (cannot be closed from this repository): live Jira Cloud and GitHub App validation against controlled test tenants (`DEPLOYMENT.md` §6 checklists). Until then, keep both integrations disabled in production (their overlays are opt-in). Also not rehearsed: a publicly trusted certificate (ACME), registry pull and real DNS (`docs/runbooks/deploy.md`).

## Phase 10 — Tenders & contract lifecycle management

**Exit**: a tender can be taken from intake through bid/no-bid, a requirement compliance matrix, internal review and submission to award, and become a contract whose obligations, milestones, guarantees, amendments and renewal dates are tracked, with dashboards, Needs Attention, search, reports and notifications, without regressing Phases 1–9.

| ID | Item | Pri |
|---|---|---|
| P10-1 | Domain foundation: money, dates, numbering (`TND`/`CTR`), permissions and baseline grants, migrations | M |
| P10-2 | Tenders: lifecycle, bid/no-bid, requirements and readiness, My Tender Work, documents and versions, addenda and clarifications, internal review gates, submission, award/loss | M |
| P10-3 | Corporate Document Vault: versions, validity, expiry, restricted classifications, requirement links | M |
| P10-4 | Contracts: lifecycle, tender → contract, project link, documents, financial confidentiality | M |
| P10-5 | Obligations with bounded recurrence, milestones, guarantees | M |
| P10-6 | Amendments with current-value/current-expiry projection, renewal actions and notice deadlines, deterministic health | M |
| P10-7 | Commercial dashboard and executive cards, Needs Attention, global search, CSV reports, notifications, the commercial monitor job, API and OpenAPI | M |
| P10-8 | Web UI (tenders, contracts, documents, project Commercial tab, settings) in English and Arabic, mobile and RTL | M |
| P10-9 | Re-certification: upgrade rehearsal on existing data, clean database, security review, performance, images, smoke | M |

**Status: P10-1…P10-9 are implemented and verified locally (2026-10-05).** Decisions are recorded in ADR-0026; the security review is `SECURITY.md` §15j.

| ID | Status | Notes |
|---|---|---|
| P10-1 | Done | Four additive migrations (`20261010090000_commercial_enums`, `20261010090100_commercial`, `20261010090200_contract_renewal_decision`, `20261010090300_tender_requirement_delete_grant`); no existing table, column or migration changed. Organization counters `TND` and `CTR`; 26 new permission keys granted to existing organizations' system roles per the §2.5 baseline |
| P10-2 | Done | Controlled operations for every gated transition; readiness = approved applicable mandatory / applicable mandatory (rounded down, NOT_APPLICABLE excluded); review rounds reuse the Phase 6 step evaluation without creating requests; submission, award, loss and create-contract are idempotent |
| P10-3 | Done | Append-only versions with their own validity; requirements link to a version; GENERAL documents need `corporate_document.view`, other classifications `corporate_document.restricted.view` |
| P10-4 | Done | Baseline fields editable only in DRAFT; money only with `contract.financial.view` in scope (absent otherwise, also in lists, search, dashboards and exports) |
| P10-5 | Done | MONTHLY / QUARTERLY / YEARLY recurrence with month-end clamping, 90-day rolling horizon, unique per (obligation, due date); evidence before completion when required; EXPIRING guarantees derived, EXPIRED set by the monitor |
| P10-6 | Done | Four-eyes amendment approval; projection rebuilt from the baseline under the contract lock; nothing renews silently; health from fixed reasons and severities |
| P10-7 | Done | Counts use the list `where` builders; 60 s cache with per-domain invalidation; `commercial.monitor` every `COMMERCIAL_MONITOR_INTERVAL_MS` (default 15 min); formula-safe, audited CSV |
| P10-8 | Done | Lists as cards on phones, detail tabs with deep links, Arabic translations, LTR money inside RTL |
| P10-9 | Done | See the Phase 10 report; the upgrade was rehearsed on a restored copy of the Phase 9 database |
| Tests | Done | Engine unit tests; core, worker and API integration tests (lifecycle, idempotency, four-eyes, projection, monitor, tenant isolation, financial redaction, vault links, exports); `15-commercial.spec.ts` covers the 41 Phase 10 E2E scenarios plus axe and overflow at 375/768/1024/1440 (primary actions in view, keyboard-opened dialogs that fit and hold focus) and RTL |

Found and fixed during verification:
- The vault document detail listed no linked requirements for any caller ("used by" was always empty); covered by `commercial.security.int.test.ts` › corporate vault.
- Search results, Needs Attention items and notifications for corporate documents linked to `/documents/<id>`, a page that does not exist; they now open the document in the vault (`/documents?open=<id>`); covered by `15-commercial.spec.ts` (31–32) and `apps/web/test/commercial.test.ts`.
- The runtime role `ops_app` had no DELETE on `tender_requirements`, so removing a requirement would have failed in production (tests run as the owner); fixed by `20261010090300_tender_requirement_delete_grant` and asserted in `production-roles.int.test.ts`.
- Activating an amendment that reactivated an expired contract recorded no `contract.value_changed` / `contract.expiry_changed` events (the second health refresh overwrote the first refresh's changes); covered by `commercial.security.int.test.ts` › reactivates an expired contract.
- Granting the sensitive commercial permissions (`contract.financial.view`, `commercial_document.view`, …) was already limited to ORG_ADMIN or an ORG-scope holder but untested; now covered by `role-admin.security.int.test.ts`.
- Restricted documents left traces for callers who may not view them: the tender/contract document lists returned a `restrictedCount` ("1 restricted document is hidden"), requirement links to hidden documents were listed with a null document, submission evidence titles and raw version ids (addenda, amendments, renewal actions, occurrence evidence) were returned, hidden documents' timeline events were listed, and write paths accepted their version ids. All are now filtered in SQL or nulled; covered by `document-confidentiality.int.test.ts`, `commercial.security.int.test.ts` and `15-commercial.spec.ts` (34).
- Submission evidence could be recorded through the API but not through the submit dialog; the dialog now offers the tender's visible document versions and the submission history shows the evidence; covered by `15-commercial.spec.ts` (11).
- Guarantee reference, customer-name and readiness-projection guarantees were untested; now covered by `commercial-search.int.test.ts`, `readiness-consistency.int.test.ts` and `15-commercial.spec.ts` (6, 17, 29–30).

Explicitly **not** in Phase 10: AI contract analysis or redlining, OCR, tender scraping or portal automation, automatic submission, e-signature, supplier portal, pricing, invoices and payments, accounting, ERP procurement, clause library.

---

## Later (post-V1 candidates, not committed)

Web Push · Microsoft Teams / Slack notifications · Entra ID federation · Jira Data Center adapter · GitHub Enterprise Server · Support access sessions (ADR-0010) · Scheduled management reports · Native mobile wrapper · Read replica for dashboards.
