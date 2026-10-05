# Product Requirements Document — Company Operations Hub

Status: **Phase 0 — remediated baseline, pending stakeholder approval** (Phase 1 paused)
Owner: Technical Product Owner
Last updated: 2026-10-02

---

## 1. Problem

A software company that builds and operates systems for government customers (e.g. water-management / water-request systems) runs its internal operations through scattered WhatsApp threads, spreadsheets, verbal approvals and ad-hoc status questions. Development work is well managed in **Jira** and **GitHub**, but nothing ties that work to:

- the projects and customers it serves,
- the operational incidents that triggered it,
- the people (and their locations) doing the work,
- the approvals and requests that keep the company running,
- a management-level view of "what needs attention right now".

## 2. Vision

> Give employees one place for internal company operations and give management one place to understand how the company is operating.

The platform sits **above and around** Jira and GitHub. It does not replace them.

Core chain:

```text
Employee → Project / Internal Operation → Support / Request / Attendance
        → Appropriate Team or Manager → Jira/GitHub (when technical work is required)
        → Resolution → Management Visibility → Complete Audit Trail
```

Optimization target: **management visibility + operational traceability + employee convenience** — not feature count.

## 3. Personas

| Persona | Primary device | Top jobs |
|---|---|---|
| Employee | Mobile + desktop | Check in/out, submit requests, track approvals, see own projects, notifications |
| Field Employee | Mobile (customer site) | Check in at site, report issue with photo, daily report, track status |
| Support Agent | Desktop | Triage, assign, escalate, link Jira, track SLA, verify, close |
| Team Lead / Department Manager | Desktop + mobile | Approve requests, team attendance, team workload context |
| Project Manager | Desktop | Project health, staff, incidents, Jira/GitHub signals, missing reports, approvals |
| Technical Manager | Desktop | Escalations, blocked Jira work, PRs awaiting review, critical incidents |
| HR Admin | Desktop | Employees, attendance oversight, corrections, HR request types |
| General Manager | Desktop + mobile | Portfolio health, critical incidents, SLA breaches, executive approvals, attendance overview |
| Org Admin | Desktop | Setup, configuration, integrations, roles, audit |

## 4. In-scope modules (V1)

Delivery phase per module is defined in `ROADMAP.md` (Phase 1 is foundations only).

1. Company / employee structure
2. Projects (incl. customers, memberships, locations, daily reports, activity)
3. Support / operational tickets (incl. SLA and escalation)
4. Internal requests & approval workflow engine
5. Attendance & work locations (geofenced check-in/out, shifts, corrections)
6. Jira integration (read-oriented cache + link/create from tickets)
7. GitHub integration (GitHub App, PR metadata only)
8. Management & role-specific dashboards
9. Notifications (in-app + email; push/Teams/Slack later)
10. Audit logs
11. Attachments / documents
12. Administration & configuration (incl. first-run setup checklist)
13. Global search (PostgreSQL full-text)
14. Tenders, Corporate Document Vault and contract lifecycle (added in Phase 10, §7.6)

## 5. Explicitly out of scope (V1)

Payroll, accounting, recruitment/ATS, CRM, sales pipeline, inventory ERP, performance scoring, source-code hosting, Git implementation, Jira/sprint replacement, chat, video, AI chatbot, Kubernetes, microservices, Elasticsearch, blockchain, screenshot/keyboard/mouse surveillance, continuous location tracking, complex offline sync.

**Developer metrics from Jira/GitHub are operational context, never per-person performance scores.** The UI must not rank individuals by ticket or commit counts.

## 6. Systems of record (business boundaries)

| Domain | Source of truth | Our platform's role |
|---|---|---|
| Development issues | Jira Cloud | Synchronized, rebuildable, read-oriented cache; link/create from support tickets |
| Repositories / PRs | GitHub | Metadata cache from GitHub App; no source code |
| Operational / customer incidents | **Us** | Full lifecycle owner |
| Projects (management level) | **Us** | Owner; maps to Jira projects and GitHub repos |
| Internal requests & approvals | **Us** | Owner |
| Attendance | **Us** | Owner |
| Tenders, contracts, corporate documents | **Us** | Owner of the internal record (the buyer's portal and the signed paper remain the legal originals; we keep versions and evidence) |
| Identity (authentication) | Keycloak (Entra ID federation later/optional) | Relying party |
| Authorization (roles, project scope) | **Us** | Owner (IdP group → role mapping optional) |
| Dashboards | **Us** | Aggregation only — never fabricated metrics |

## 7. Key functional requirements (summary)

Detailed acceptance criteria per feature are tracked in `ROADMAP.md` backlog items. Highlights:

### 7.1 Support vs Jira
- A **support ticket** is an operational/business problem; a **Jira issue** is development work. They are never merged.
- Ticket ↔ Jira issue is **many-to-many** (one ticket may need backend + DB work; one Jira bug may explain several tickets).
- Authorized staff can search Jira, link an existing issue, or create a new one from a ticket. Jira status is shown read-only with deep links.
- Ticket event history is **append-only**.

### 7.2 SLA
- SLA policies are configuration (per org, optionally per project / severity / priority).
- Track first-response and resolution SLA with `ON_TRACK | AT_RISK | BREACHED | PAUSED` (paused e.g. while `WAITING_FOR_CUSTOMER`).
- Escalation rules are configurable, multi-level, deduplicated, and each escalation is recorded.

### 7.3 Requests & approvals
- Generic **Request Type + versioned Workflow** model; no per-type subsystems.
- Submitted requests pin the workflow version used at submission.
- Approver resolution supports: direct manager, department manager, project manager, specific role, specific user; conditions on form values (e.g. amount > threshold); delegation.
- "Needs My Approval" inbox is a first-class surface on every manager dashboard.

### 7.4 Attendance
- Explicit check-in/out only; location is captured **only** at those actions.
- Server computes distance (haversine) to configured `WorkLocation` geofences; stores coordinates, accuracy, server timestamp, result.
- Remote work and business missions are recorded via approved requests, not by spoofing location.
- Geolocation is presented as a **validation aid, not tamper-proof evidence**. Low-accuracy handling follows §12-H.

### 7.5 Dashboards
- Every metric is derived from real records and every card deep-links to the filtered list behind it.
- "Needs Attention" feed is a prioritized, actionable list (critical incidents, SLA breaches, approvals waiting, missing daily reports, blocked Jira work, failing PR checks).

### 7.6 Tenders and contracts (Phase 10, ADR-0026)
- A **tender** moves from intake through a recorded bid/no-bid decision, preparation, internal review and submission to award or loss. Gated steps happen only through their controlled action; a deadline change after intake is an addendum that keeps the old deadline.
- Requirements form a compliance matrix with owners, reviewers and due dates. **Readiness** = approved applicable mandatory requirements / applicable mandatory requirements, rounded down; NOT_APPLICABLE is excluded. Owners see their work in *My Tender Work*.
- The **Corporate Document Vault** keeps reusable company documents with versions and validity, warns before expiry and links a specific version to a requirement.
- A **contract** keeps its original value and expiry forever; effective amendments and renewal actions produce the current value and expiry. Obligations (optionally recurring), milestones and guarantees are tracked with owners, due dates and evidence. Nothing renews or completes automatically.
- Contract health is a fixed set of explainable reasons (expiry, notice deadline, overdue obligations, guarantees …), never a score.
- Financial values and confidential documents are visible only with their own permissions, in every surface including exports.
- Out of scope: AI analysis, OCR, scraping, portal automation, automatic submission, e-signature, supplier portal, pricing, invoicing, payments and accounting.

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Tenancy | Every tenant-owned row has `organization_id`; every relation between tenant-owned entities preserves organization identity; cross-org access impossible through API manipulation; dedicated negative tests (`SECURITY.md` §4, ADR-0003) |
| Security | OIDC SSO, MFA enforced for privileged access via IdP step-up, RBAC + contextual scope, OWASP ASVS L2-aligned controls (`SECURITY.md`) |
| Auditability | Immutable audit log for security-sensitive and business-critical actions; no secrets in audit/logs |
| Reliability | Idempotent jobs and webhooks; retries with backoff; dead-letter visibility; resumable syncs |
| Performance | p95 API < 300 ms for list/detail endpoints at enterprise scale (≤ 5k employees/org, ≤ 500k Jira issues/org); all lists paginated |
| Responsiveness | Mobile-first for field flows; verified at 375 / 768 / 1024 / 1440 px (`UI_UX.md`) |
| Accessibility | WCAG 2.2 AA-oriented patterns; automated axe checks in E2E |
| i18n | English first; Arabic + RTL ready; no hard-coded UI strings |
| Deployability | Docker Compose on a single Linux VPS; cloud-portable; no Kubernetes |
| Time | UTC in DB; display in org/user time zone (configurable per org, never hard-coded — §12-C) |
| Email | Provider-agnostic `EmailChannel` port; SMTP adapter (§12-B) |
| Retention | Configurable per org; nothing is purged until a policy is explicitly configured (§12-E) |

## 9. Success criteria

See master spec §53. Summarized as measurable V1 outcomes:

- GM can answer "what needs attention" from one screen with zero manual Jira/GitHub checks.
- PM can see staff, incidents, field reports, Jira and GitHub signals for a project on one page.
- Field employee can check in, report an issue with a photo, and submit a daily report on a phone in under 2 minutes each.
- 100% of approvals are traceable (who, when, which workflow version, comment).
- Jira historical import of 10k+ issues completes in the background, is restartable, and never duplicates.

## 10. Specification review — contradictions, gaps and risks

Findings from the Phase 0 review of the master specification, with the decision taken. Architectural decisions are recorded as ADRs in `docs/adr/`. Version evidence is in `DEPENDENCIES.md`.

| # | Finding | Decision |
|---|---|---|
| R1 | Prisma's npm `latest` tag points to **8.0.0-rc.19** (pre-release). Spec forbids pre-release on critical paths. | Use **Prisma 7.10.0** (latest GA, exact pin). ADR-0006. |
| R2 | TypeScript 7.0.2 is the newest stable, but **typescript-eslint 8.71 peers `<6.1.0`** and `@nestjs/swagger` 12 peers `^5.5 \|\| ^6.0`. | Pin **TypeScript 6.0.3**; revisit when the ecosystem supports 7. ADR-0005. |
| R3 | Local machine runs Node 20.18.1 (EOL 2026-04-30). Prisma 7 needs ≥ 20.19; Vitest 5, nestjs-pino, nestjs-cls, testcontainers, jsdom need ≥ 22.x/24.x. | Standardize on **Node 24 LTS** (24.21.0) for `.nvmrc`, Docker base and CI. ADR-0007. Local fix documented in `ROADMAP.md` §Local environment prerequisites. |
| R4 | `nestjs-zod` does **not** support NestJS 12 / Swagger 12. | Use NestJS 12's **native Standard Schema** validation with shared Zod 4 schemas in `packages/validation`; no class-validator. ADR-0004. |
| R5 | Jira Cloud removed `/rest/api/3/search`. Replacement `/search/jql` uses `nextPageToken` and **returns no total**. | Use `POST /rest/api/3/search/approximate-count` for an *estimated* denominator labeled "≈". Resume via a `created` checkpoint + idempotent upsert (page tokens are not durable). `INTEGRATIONS.md` §1. |
| R6 | The spec did not state Jira Cloud vs Data Center. | **Resolved 2026-10-02: Jira Cloud** (stakeholder answer). Build against Jira Cloud OAuth 2.0 (3LO) behind a `JiraClient` port. A Data Center adapter is out of V1 scope. |
| R7 | MinIO community edition: the official MinIO README states it is now distributed as source only, with no new pre-compiled binaries; no prebuilt `minio/minio` image tag could be verified on 2026-10-02. | Development uses **SeaweedFS 4.48** (verified image + digest) behind a vendor-neutral `StoragePort`; production uses any S3-compatible service chosen by deployment policy. Deviation from spec "Development: MinIO" recorded in ADR-0008. |
| R8 | Contextual project permissions cannot be represented well in IdP tokens. | **Keycloak authenticates; our DB authorizes.** Optional IdP group → role mapping at login. ADR-0002, ADR-0012. |
| R9 | Notifications are phase-ordered late (spec §19) but SLA escalation and approvals need them. | Outbox + in-app notification **foundation** in Phase 1; email channel and SSE in Phase 3; preferences UI in Phase 8. ADR-0011. |
| R10 | Dashboard "On Leave / Remote" needs approved requests (Phase 6) before attendance (Phase 7) and dashboards (Phase 8). | Keep order; Phase 7 consumes approved requests via a domain event. |
| R11 | Geolocation requires a secure context; phone testing over LAN needs TLS. | Dev reverse proxy with locally-trusted certs (`DEPLOYMENT.md`); `localhost` is a secure context. |
| R12 | "SUPER_ADMIN" crosses tenants, conflicting with strict isolation. | `SUPER_ADMIN` is a **platform** role, not an org role; no implicit tenancy bypass; explicit, time-boxed, audited support access sessions (deferred feature). ADR-0010. |
| R13 | Real-time updates requested while staying a horizontally-scalable monolith. | SSE from the API, fan-out via Redis pub/sub; delivered in Phase 3 (ADR-0011). |
| R14 | Jira issue keys change when issues move projects. | Immutable Jira `id` is the unique key; `key` is mutable and indexed. |
| R15 | PostgreSQL search over potentially 500k Jira rows. | `tsvector` generated columns + GIN; `pg_trgm` for key/prefix lookups. Global search UI in Phase 8 (ADR-0011). |
| R16 | openapi-typescript 7.13.0 peers `typescript ^5.x`, not 6. | Isolate codegen in `packages/api-client` with a package-local `typescript@5.9.3`; no other package uses TS 5. ADR-0005. |
| R17 | ESLint 9 reached EOL on 2026-08-06; `eslint-config-next` and `eslint-plugin-jsx-a11y` do not declare ESLint 10 support. | ESLint 10 flat config with `@next/eslint-plugin-next`, `@eslint-react`, react-hooks; accessibility enforced by axe tests. ADR-0014. |
| R18 | NestJS 12 and many dependencies (file-type, nestjs-pino, Prisma generator) are ESM. | ESM across the monorepo (`"type": "module"`, `module: nodenext`). ADR-0013. |
| R19 | The original plan said "enable pnpm via Corepack". pnpm.io/installation (checked 2026-10-02) documents pnpm 12 as a native executable and recommends `npx get-pnpm` on Windows; the Phase 0 docs should not depend on an install path not verified for this machine. | Install pnpm via the official pnpm installation instructions; no Corepack dependency in docs or CI (CI uses `pnpm/action-setup`). |
| R20 | Several pinned packages were released within 48 h of verification. | Minimum-release-age policy at lock time (Phase 1, P1-1); `DEPENDENCIES.md` updated with locked versions. |
| R21 | Global `users` + per-org membership is needed for SUPER_ADMIN and future multi-org users; spec implied per-org users. | Global `users` keyed by IdP `(iss, sub)`, `organization_members` per org, per-org roles. ADR-0012. |

## 11. Questions for stakeholders (non-blocking)

None of these block Phase 1. The §12 baselines apply until answered.

1. Is Microsoft Entra ID the corporate directory, and when should federation be enabled? (§12-A)
2. Which SMTP / transactional provider for production? (§12-B)
3. Which deployment target satisfies data-residency obligations for government contracts? (§12-D)
4. Final retention periods per data category, approved by legal/HR? (§12-E)
5. Confirm or adjust the RBAC baseline in `SECURITY.md` §2.5 per role. (§12-F)
6. Low-accuracy check-in policy: reject vs flag for manual review, and the threshold. (§12-H)

Resolved: Jira deployment = **Jira Cloud** (2026-10-02).

## 12. Business baselines (apply until stakeholders decide otherwise)

| ID | Topic | Baseline |
|---|---|---|
| A | Identity federation | Keycloak local users for V1. Microsoft Entra ID federation is a **later, optional** Keycloak configuration change (identity brokering); application code is IdP-agnostic (OIDC only). |
| B | Email | `EmailChannel` provider abstraction. Development: Mailpit SMTP capture. Production: SMTP configured via environment (host, port, TLS, credentials as secrets). Other providers = new adapter, no domain change. Delivered in Phase 3. |
| C | Time zone & work week | Per-org configurable settings (`organizations.timezone`, `organization_settings.work_week`). The **development seed only** uses `Africa/Cairo` and Sunday–Thursday. No code path hard-codes a zone or work week; new orgs created without values must choose them in setup. |
| D | Data residency | A **deployment policy**, not an application feature: the stack is self-hostable (Docker Compose) and every external dependency (DB, Redis, object storage, SMTP, IdP) is replaceable by an in-country/on-prem equivalent. Outbound calls are only to Jira Cloud, GitHub, and configured SMTP/Sentry (Sentry opt-in). |
| E | Retention | Configurable per org and data category (`retention_policies`). **Proposed examples only:** attendance coordinates 24 months, audit logs 7 years. **No destructive retention job runs unless a policy is explicitly configured** for that category; absent a policy, data is retained. |
| F | RBAC | **"V1 least-privilege baseline; business-configurable policy"** — `SECURITY.md` §2.5. Roles are per-org data; ORG_ADMIN may adjust within the code-defined permission catalog. |
| G | MFA | Required (step-up enforced by the API) for SUPER_ADMIN, ORG_ADMIN, any holder of `integration.manage`, `role.manage`, `org.settings.manage`, `employee.manage`, `attendance.admin`, `audit.view`, and support access sessions. `SECURITY.md` §2.3 and §3.2. |
| H | Low-accuracy geolocation | Accuracy is always sent to the server and stored. Poor accuracy is **never** treated as strong evidence. Per-org configurable `maxAccuracyMeters` threshold; the org later chooses `REJECT` or `FLAG_FOR_REVIEW` (baseline: `FLAG_FOR_REVIEW`). `SECURITY.md` §9. |

## 13. Assumptions

- Single company in V1, but the data model and enforcement are multi-tenant from day one.
- Jira Cloud OAuth app is owned by the integration user registering webhooks (non-public apps only deliver webhooks if the registering user owns the app — `INTEGRATIONS.md` §1).
- The GitHub organization permits installing a GitHub App with read-only metadata/PR/checks permissions.
- Production host is a single Linux VPS with Docker; TLS terminated at Nginx.
- Users have modern evergreen browsers; field users have smartphones with GPS.
