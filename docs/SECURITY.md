# Security

Status: Phase 0 baseline (remediated 2026-10-02). Target: OWASP ASVS 5.0 Level 2-aligned controls, OWASP Top 10 (2025) coverage.

---

## 1. Threat model (summary)

| Asset | Threats | Primary controls |
|---|---|---|
| Tenant data | Cross-org access via ID manipulation (IDOR/BOLA), cross-org relationships | Server-derived tenant context, scoped repositories, Prisma guard extension, composite FKs, 404-on-foreign-ID, negative test suite (§4) |
| Sessions | Theft, fixation, CSRF | HttpOnly `__Host-` cookie, SameSite=Lax, rotation on login, CSRF synchronizer token + Origin check, idle/absolute timeouts |
| Authorization | Privilege escalation, UI-only checks | Code-defined permission catalog, guard + resource policy, audited role grants, MFA step-up for privileged capabilities |
| Integration credentials | Leakage via API, logs, DB dump | Never returned to clients, AES-256-GCM envelope encryption, log redaction, encrypted backups |
| Webhooks | Forgery, replay, flooding, cross-tenant routing | Signature/JWT verification before parsing, delivery-ID idempotency, tenant resolved from verified binding, rate limits, body limits |
| Attachments | Malware, path traversal, cross-tenant download, stored XSS | Server-generated keys, MIME sniffing + allow-list, size limits, short-lived pre-signed URLs after authz, `Content-Disposition: attachment`, optional ClamAV |
| Attendance location | Spoofed GPS, low accuracy, privacy over-collection | Server-side distance, accuracy always recorded, low accuracy never strong evidence (§9), capture only at check-in/out |
| Audit trail | Tampering | Append-only tables, no update/delete paths, restricted DB grants |
| Platform role | Invisible cross-tenant bypass | SUPER_ADMIN is not a tenant role; no implicit bypass (§14, ADR-0010) |
| Availability | Abuse, expensive queries | Rate limiting, pagination caps, query timeouts, background jobs |

## 2. Authorization model

### 2.1 Concepts

- **Permission** — capability key defined **in code** (`packages/shared/src/permissions.ts`) so catalog and enforcement cannot drift (ADR-0012).
- **Scope** — breadth of a grant: `SELF`, `TEAM`, `DEPARTMENT`, `PROJECT`, `ORG`.
  - `SELF`: resources the member owns/created/is assigned to.
  - `TEAM`: the member's direct and indirect reports and teams they lead.
  - `DEPARTMENT`: members/resources of departments the member manages.
  - `PROJECT`: resources of projects where the member is a `project_member` (or PM/TM).
  - `ORG`: all resources in the organization.
  - Scopes are distinct axes; the policy evaluates each grant independently and allows if **any** grant matches.
- **Role** — per-org bundle of `(permission, scope)` grants. System role templates are code-defined and materialized per organization (ADR-0012).
- **Platform role** — `SUPER_ADMIN` on `users.platform_role` (§14).

### 2.2 Enforcement

1. `PermissionGuard` (route-level): `403 FORBIDDEN` if the member holds the permission at **no** scope.
2. **Resource policy** (service-level, authoritative): `policy.assert(member, 'support.assign', ticket)` evaluates scope against the loaded resource. Lists use the same policy compiled into a Prisma `where` fragment (`policy.scopeFilter(member, 'support.view')`).
3. Foreign-tenant or out-of-scope single-resource reads return **404**; actions on visible-but-forbidden resources return **403**.
4. Effective permissions are computed at session load, cached in the session, and invalidated on role/membership change (`authz_version` on the member).

### 2.3 Privileged capabilities — MFA required

MFA (Keycloak step-up, §3.2) is **required** before any of the following can be exercised:

- `SUPER_ADMIN` (platform role) — always, at login.
- `ORG_ADMIN` role holders — always, at login.
- Any member holding `integration.manage`, `role.manage`, `org.settings.manage`, `employee.manage`, `attendance.admin`, `audit.view` or `request.admin` (workflow routing decides who approves; ADR-0021) — enforced on the endpoints guarded by those permissions (`MfaGuard`).
- Support access sessions (deferred, ADR-0010).

The set is a code constant (`PRIVILEGED_PERMISSIONS` in `packages/shared`); adding a privileged permission requires updating this section.

### 2.4 Permission catalog

| Key | Meaning |
|---|---|
| `org.settings.manage` | Org profile, time zone, work week, retention policies, geolocation settings, setup checklist |
| `role.manage` | Grant/revoke roles, edit role grants within the catalog, IdP group mappings |
| `employee.view` | Directory & profiles (contact fields need `employee.view_contact`) |
| `employee.view_contact` | Phone/personal contact fields |
| `employee.manage` | Create/invite/edit/disable employees, set manager/department |
| `department.manage` | Departments, teams, job titles |
| `project.view` | View projects and project pages |
| `project.create` | Create projects/customers |
| `project.manage` | Edit project, status, health, settings, locations |
| `project.assign_members` | Add/remove project members and project roles |
| `daily_report.submit` | Submit daily reports for projects the member belongs to |
| `daily_report.view` | View daily reports + missing-report status |
| `support.view` | View tickets |
| `support.create` | Report tickets |
| `support.comment` | Comment on visible tickets |
| `support.internal_note` | Write/read internal notes |
| `support.triage` | Set severity/priority/category, move NEW→TRIAGED |
| `support.assign` | Assign team/agent |
| `support.escalate` | Escalate / mark waiting for development |
| `support.resolve` | Resolve tickets |
| `support.verify` | Verify a resolution |
| `support.close` | Close/reopen |
| `support.config` | Categories, components, SLA policies, escalation rules |
| `jira.view` | View Jira cache data |
| `jira.link` | Link/unlink Jira issues to tickets |
| `jira.create_issue` | Create Jira issues from tickets |
| `github.view` | View GitHub PR data |
| `github.link` | Link/confirm PRs to tickets/Jira issues |
| `integration.manage` | Connect Jira/GitHub, mappings, imports, sync control |
| `request.create` | Submit own requests |
| `request.view` | View requests (scope-bound) |
| `request.approve` | Act as approver (still requires being the resolved approver) |
| `request.fulfill` | Perform fulfillment steps |
| `request.admin` | Request types, form schemas, workflows, delegation overrides |
| `attendance.self` | Own check-in/out & history |
| `attendance.team` | View team attendance and decide low-accuracy reviews in scope (corrections are approved through the request workflow, ADR-0022) |
| `attendance.config` | Work locations, geofences, shifts, shift assignments |
| `attendance.admin` | Org-wide attendance records, corrections, low-accuracy review decisions |
| `dashboard.project` | Project dashboards |
| `dashboard.executive` | Executive/management dashboard |
| `notification.config` | Org notification rules |
| `audit.view` | Read audit logs |
| `tender.view` | View tenders at FULL level (scope-bound; reviewers and requirement owners get contextual access, §2.6) |
| `tender.create` | Create tenders |
| `tender.edit` | Edit tenders, manual lifecycle moves, bid/no-bid, addenda, clarifications, tender documents |
| `tender.delete_draft` | Delete DRAFT tenders |
| `tender.manage_requirements` | Requirements, owners, reviewers, NOT_APPLICABLE, requirement document links |
| `tender.review` | Decide TECHNICAL / COMMERCIAL / LEGAL review gates (still requires being an assigned reviewer) |
| `tender.approve` | Decide the FINAL review gate (still requires being an assigned reviewer) |
| `tender.submit` | Record the submission with evidence |
| `tender.record_award` | Record an award and create the contract |
| `tender.record_loss` | Record a loss |
| `tender.financial.view` | See tender estimates, bid and award values, bid securities (sensitive, §2.6) |
| `contract.view` | View contracts at FULL level (scope-bound; obligation, milestone and guarantee owners get contextual access) |
| `contract.create` | Create contracts |
| `contract.edit` | Edit contracts and non-signing lifecycle moves |
| `contract.approve` | Signing transitions and amendment approval (never the amendment's author) |
| `contract.manage_documents` | Contract documents and versions |
| `contract.manage_obligations` | Obligations, occurrences, waivers |
| `contract.manage_milestones` | Milestones |
| `contract.manage_guarantees` | Guarantees on tenders and contracts |
| `contract.manage_amendments` | Draft, submit and activate amendments |
| `contract.manage_renewal` | Renewal actions and decisions |
| `contract.financial.view` | See contract values, amendment value deltas, guarantee amounts, money columns in exports (sensitive, §2.6) |
| `corporate_document.view` | Read GENERAL corporate documents |
| `corporate_document.manage` | Create, version and archive corporate documents |
| `corporate_document.restricted.view` | Read non-GENERAL corporate documents (sensitive, §2.6) |
| `commercial_document.view` | Read non-GENERAL tender and contract documents (sensitive, §2.6) |

### 2.5 V1 least-privilege baseline; business-configurable policy

This matrix is the **V1 least-privilege baseline; business-configurable policy**. It is materialized into each organization's roles at creation; holders of `role.manage` may change grants within the catalog (changes audited, MFA required). Principles: org admins configure but do not operate support or consume dashboards; GMs observe and approve but do not manage projects or work tickets; HR manages people and attendance but does not see projects or audit; employees see only their own items plus projects they belong to.

Legend: **O** ORG · **D** DEPARTMENT · **P** PROJECT · **T** TEAM · **S** SELF · **✓** granted, effective target defined by the rule in the notes · blank = not granted. Roles: OA = ORG_ADMIN, GM = GENERAL_MANAGER, TM = TECHNICAL_MANAGER, DM = DEPARTMENT_MANAGER, PM = PROJECT_MANAGER, TL = TEAM_LEAD, HR = HR_ADMIN, SA = SUPPORT_AGENT, FE = FIELD_EMPLOYEE, EMP = EMPLOYEE.

| Permission | OA | GM | TM | DM | PM | TL | HR | SA | FE | EMP |
|---|---|---|---|---|---|---|---|---|---|---|
| org.settings.manage | O | | | | | | | | | |
| role.manage | O | | | | | | | | | |
| employee.view | O | O | O | O | O | O | O | O | O | O |
| employee.view_contact | O | O | O | D | P | T | O | | | |
| employee.manage | O | | | | | | O | | | |
| department.manage | O | | | | | | O | | | |
| project.view | O | O | O | D | P | P | | O | P | P |
| project.create | O | | O | | | | | | | |
| project.manage | O | | O | | P | | | | | |
| project.assign_members | O | | O | | P | | | | | |
| daily_report.submit | | | | | P | P | | | P | |
| daily_report.view | | O | O | D | P | P | | O | P | |
| support.view | S | O | O | D | P | P | S | O | P | S |
| support.create | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| support.comment | S | | O | D | P | P | S | O | P | S |
| support.internal_note | | | O | | P | P | | O | | |
| support.triage | | | O | | P | | | O | | |
| support.assign | | | O | | P | P | | O | | |
| support.escalate | | | O | | P | P | | O | | |
| support.resolve | | | O | | | P | | O | | |
| support.verify | S | | O | | P | | S | O | P | S |
| support.close | | | O | | P | | | O | | |
| support.config | O | | O | | | | | | | |
| jira.view | O | O | O | D | P | P | | O | | |
| jira.link | | | O | | P | P | | O | | |
| jira.create_issue | | | O | | P | P | | O | | |
| github.view | O | O | O | D | P | P | | | | |
| github.link | | | O | | P | P | | | | |
| integration.manage | O | | O | | | | | | | |
| request.create | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| request.view | O | O | T | D | P | T | O | S | S | S |
| request.approve | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| request.fulfill | O | | | | | | O | | | |
| request.admin | O | | | | | | O | | | |
| attendance.self | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| attendance.team | | O | T | D | P | T | O | | | |
| attendance.config | O | | | | | | O | | | |
| attendance.admin | | | | | | | O | | | |
| dashboard.project | | O | O | D | P | | | | | |
| dashboard.executive | | O | O | | | | | | | |
| notification.config | O | | | | | | | | | |
| audit.view | O | O | | | | | | | | |
| tender.view | O | O | O | S | P | | | | | |
| tender.create | | O | O | | P | | | | | |
| tender.edit | | O | O | S | P | | | | | |
| tender.delete_draft | | O | O | | P | | | | | |
| tender.manage_requirements | | O | O | S | P | | | | | |
| tender.review | | ✓ | ✓ | ✓ | ✓ | ✓ | | | | |
| tender.approve | | O | O | | | | | | | |
| tender.submit | | O | O | S | P | | | | | |
| tender.record_award | | O | O | | | | | | | |
| tender.record_loss | | O | O | | | | | | | |
| tender.financial.view | | O | O | | | | | | | |
| contract.view | O | O | O | | P | | | | | |
| contract.create | | O | O | | | | | | | |
| contract.edit | | O | O | | | | | | | |
| contract.approve | | O | | | | | | | | |
| contract.manage_documents | | O | O | | P | | | | | |
| contract.manage_obligations | | O | O | | P | | | | | |
| contract.manage_milestones | | O | O | | P | | | | | |
| contract.manage_guarantees | | O | O | | | | | | | |
| contract.manage_amendments | | O | O | | | | | | | |
| contract.manage_renewal | | O | O | | | | | | | |
| contract.financial.view | | O | O | | | | | | | |
| corporate_document.view | O | O | O | O | O | O | O | | | |
| corporate_document.manage | O | O | O | | | | O | | | |
| corporate_document.restricted.view | | O | O | | | | | | | |
| commercial_document.view | | O | O | | | | | | | |

Notes:
- `support.create`: project-less internal tickets are always allowed; a project-linked ticket additionally requires `project.view` on that project. Reporters see their own tickets via `support.view` at `S`.
- `request.create` submits requests for oneself (on-behalf-of requires `request.admin`). `attendance.self` acts only on the member's own records.
- `request.approve` grants nothing by itself: the policy also requires a `PENDING` `request_approvals` row for the member (or an active delegation).
- `request.view` at OA: needed because OA holds `request.fulfill`/`request.admin`.
- Members commonly hold several roles; grants union.
- `SUPER_ADMIN` is not in this table (§14).
- Changes to this baseline after Phase 0 approval are tracked in `ROADMAP.md` (business decision, not an ADR).
- Phase 10 rows (`tender.*`, `contract.*`, `corporate_document.*`, `commercial_document.view`) were added by migration `20261010090100_commercial` to every existing organization's system roles; no existing grant changed. `tender.review` / `tender.approve` grant nothing by themselves: the policy also requires an assigned review on an open gate.

### 2.6 Commercial confidentiality and contextual access (Phase 10, ADR-0026)

- **Contextual access.** FULL: the tender or contract is inside the caller's `tender.view` / `contract.view` scope, or the caller is an assigned tender reviewer. INVOLVED: the caller owns or reviews a requirement, or owns an obligation, occurrence, milestone or guarantee of the record; they see the header, GENERAL documents and their own items only. Anything else, including every foreign-organization id, is `404`.
- **Financial values** (estimates, bid/award/contract values, amendment value deltas, guarantee amounts) are returned only with `tender.financial.view` / `contract.financial.view` in scope for that record; otherwise the field is absent. The same check runs in lists, search, dashboards, the project Commercial tab and CSV exports (money columns only for holders, blank outside scope; `contracts-by-value` requires the permission).
- **Document classifications** GENERAL, COMMERCIAL_CONFIDENTIAL, LEGAL_RESTRICTED, BANKING_RESTRICTED. Non-GENERAL tender/contract documents need `commercial_document.view`, non-GENERAL corporate documents `corporate_document.restricted.view`. Hidden documents are neither listed nor counted: the classification filter runs in SQL before lists, pages, search, dashboard and Needs Attention numbers; requirement links to them are omitted, references to their versions (submission evidence, addenda, amendments, renewal actions, occurrence evidence) read as null, their timeline events are filtered, writes naming them fail as not found, and their attachments return `404` through the registered attachment policies.
- **Granting sensitive permissions.** `SENSITIVE_COMMERCIAL_PERMISSIONS` (`tender.financial.view`, `contract.financial.view`, `commercial_document.view`, `corporate_document.restricted.view`) can be granted, or added to a role, by a role manager who is not an ORG_ADMIN holder only when they hold that permission at ORG scope.
- **Rate limits.** Contract transitions, renewal and amendment actions, guarantee status changes, commercial settings and the tender delete/submit/correct/award/loss/create-contract operations use the per-user `sensitive` bucket.

## 3. Authentication and sessions

### 3.1 Baseline
- Keycloak 26 (OIDC Authorization Code + PKCE, confidential client `ops-api`). `ARCHITECTURE.md` §6, ADR-0002.
- No local passwords in our database.
- ID token validated (JWKS signature, `iss`, `aud`, `exp`, `nonce`); user keyed by `(iss, sub)` — **never by email**.
- Sessions: Redis, 256-bit random IDs, rotated on login, on step-up and on org switch; idle 30 min, absolute 12 h (org-configurable within bounds).
- Back-channel logout (`/api/v1/auth/backchannel-logout`) validates Keycloak logout tokens and deletes sessions.
- Disabled `organization_members` are rejected at session load even if the IdP session is valid.
- Microsoft Entra ID federation is later/optional (Keycloak identity brokering), not Phase 1.

### 3.2 MFA step-up mechanism
- Keycloak realm: ACR→LoA mapping (e.g. `mfa` → LoA 2) and a browser flow using *Condition – Level of Authentication* sub-flows with OTP and/or WebAuthn. These features are documented in the Keycloak Server Administration Guide (checked 2026-10-02).
- The API stores the validated `acr` and its timestamp in the session.
- `MfaGuard` checks §2.3: if required and the session `acr` is insufficient (or older than the org's step-up max age), respond `401 MFA_REQUIRED`. The web app redirects to `/api/v1/auth/step-up?returnTo=…`, which starts a new authorization request with `acr_values=mfa`.
- For SUPER_ADMIN and ORG_ADMIN the requirement is applied at login (session created only with `acr = mfa`).
- The API never trusts a UI flag; only the validated token's `acr`.
- Phase 1 tests: privileged endpoint without MFA → `401 MFA_REQUIRED`; after step-up → allowed; non-privileged endpoints unaffected.

### 3.3 As implemented (Phase 1)
- **Login**: `GET /api/v1/auth/login` stores the OIDC transaction (state, nonce, PKCE verifier, purpose, `returnTo`) in Redis under `ops:oidc-tx:<sha256(handle)>` (10 min TTL, consumed once with `GETDEL`); the browser only holds the opaque handle in `__Host-ops_oidc`. Replayed or forged callbacks fail (`transaction_missing` / `callback_rejected`). Implicit, password and no-PKCE flows are disabled on the `ops-api` client.
- **Callback**: `openid-client` validates the code exchange and ID token (signature via JWKS, `iss`, `aud`, `exp`, `nonce`). The user is upserted by `(iss, sub)`; any pre-existing session cookie is destroyed (fixation defence). Users with no ACTIVE membership in an ACTIVE organization get no session (`/?authError=no_active_membership`). For `ORG_ADMIN` the callback restarts authorization with `acr_values=mfa` before a session exists.
- **Session**: cookie `__Host-ops_sid` (HttpOnly, Secure, SameSite=Lax, `Path=/`, no Domain), 256-bit random id; Redis key `ops:sess:<sha256(id)>`. Idle timeout 30 min (sliding, written at most once per 60 s), absolute 12 h (`SESSION_*_TIMEOUT_MINUTES`; per-org bounds are later). Ids rotate on login, step-up, organization switch and when the member's `authz_version` changes. The ID token (kept only as `id_token_hint` for logout) is AES-256-GCM encrypted in the session; access and refresh tokens are not stored and there is **no token refresh**, so the Keycloak session governs re-login only.
- **Per-request revalidation**: each authenticated request re-reads the membership and organization status and `authz_version` from PostgreSQL. A disabled membership or organization destroys the session (`401 SESSION_EXPIRED`); a changed grant reloads permissions and rotates the session id.
- **Organization context**: the active organization lives only in the session. `PUT /api/v1/me/active-organization` validates the target against the user's own ACTIVE memberships (unknown, foreign or inactive → `404`), enforces login-time MFA for the target roles, rotates the session and audits `auth.organization.switched_out` / `switched_in`.
- **Logout**: `POST /api/v1/auth/logout` (CSRF-protected) deletes the session and returns the Keycloak end-session URL with `id_token_hint`. **Back-channel logout** (`POST /api/v1/auth/backchannel-logout`, public, CSRF-exempt) verifies the logout token with `jose` (JWKS signature, `iss`, `aud`, ≤ 5 min `iat`, `events` claim, no `nonce`, `sid` or `sub`, `jti` single-use in Redis) and deletes every session linked to that IdP session.
- **CSRF**: unsafe methods require both an `Origin` header in the allow-list (`APP_PUBLIC_URL` + `CORS_ORIGINS`) and `X-CSRF-Token` equal (constant-time) to the session's synchronizer token from `GET /api/v1/auth/csrf`. Missing `Origin` is rejected.
- **Guard order**: Throttler (per IP) → Session (deny by default; `@Public` opt-out) → PrincipalRateLimit (per user, §5) → CSRF (`@SkipCsrf` only for back-channel logout) → Permission (`@RequirePermission`; privileged permissions additionally require `acr=mfa` within `MFA_MAX_AGE_MINUTES`, otherwise `401 MFA_REQUIRED`). There is no separate `MfaGuard`.
- **No tokens in the browser**: the browser holds only the HttpOnly session and OIDC-transaction cookies. The E2E suite asserts that `document.cookie`, `localStorage` and `sessionStorage` contain no token-like values after login.
- **Invitations**: employees are created with an `INVITED` membership and a single-use invitation link (256-bit token; only its SHA-256 hash is stored; 7-day expiry; reissue invalidates the previous link; revocable). Redeeming happens in the OIDC callback: the signed-in Keycloak user is bound to the invited membership once; an expired, revoked, used or foreign link creates no session. No passwords are set or handled by the application.
- **Revoking access without refresh tokens** (ADR-0002 amendment): disabling a membership (`PUT /employees/:id/status`) or changing its grants takes effect on the member's next request through per-request revalidation. To end a user's sign-in everywhere, disable the user in Keycloak and end their Keycloak sessions; back-channel logout then deletes the matching application sessions.
- **Realm**: `infra/docker/keycloak/realms/company-ops-realm.json` (brute-force protection, 12-character password policy, TOTP, LoA browser flow with `acr.loa.map {"pwd":1,"mfa":2}`, SSO idle 30 min / max 12 h, back-channel logout URL with session required).

## 4. Tenant isolation (ADR-0003)

### 4.1 Invariants
1. Tenant context is **server-derived** (session `activeOrgId`; in workers, the job's `organizationId` validated against the target record). Client-supplied `organizationId` is rejected by strict schemas.
2. **Every relation between tenant-owned entities MUST preserve organization identity.**
3. A referenced UUID is **never trusted because it exists**; it is resolved through a tenant-scoped lookup before linking.
4. Foreign-tenant identifiers behave as non-existent (`404`).

### 4.2 Enforcement layers
1. Tenant-scoped repositories (every read/write includes `organization_id`; single-row reads use `findFirst({ where: { id, organizationId } })`).
2. Prisma guard extension: queries on tenant models without an `organizationId` condition throw (fail closed).
3. Relationship linking only via services that load each referenced entity through its tenant-scoped repository.
4. **Composite foreign keys** `(organization_id, x_id) → parent(organization_id, id)` with `UNIQUE (organization_id, id)` on parents (`DATA_MODEL.md` §2). Polymorphic references are covered by layers 1–3 + tests.
5. PostgreSQL RLS: Phase 9 evaluation.

### 4.3 Raw SQL rule
- Raw SQL (`$queryRaw`, `$executeRaw`, TypedSQL) is not used for tenant-owned business data unless a reviewed need exists (full-text search, counters, bulk upserts, concurrent index creation in migrations).
- Approved raw SQL lives only in `packages/core/src/platform/db/sql/`, uses tagged-template parameter binding, and **explicitly binds `organization_id`** in every statement touching tenant tables.
- `$queryRawUnsafe` and `$executeRawUnsafe` are forbidden (ESLint `no-restricted-properties`). The only exception is `**/test/**/*.security.int.test.ts`, which calls them to prove the tenant guard rejects them at runtime; tagged raw SQL stays banned there too.
- Every raw-SQL tenant statement has a dedicated cross-tenant test.

**Guard behaviour as implemented** (`packages/core/src/platform/tenancy/tenant-guard.ts`): with no tenant context every tenant-model operation throws; reads and bulk writes get `organizationId` injected and a conflicting value throws `TenantIsolationError`; creates, nested writes, upserts and connects are checked for the bound organization; interactive and batch transactions stay guarded; `$queryRawUnsafe`/`$executeRawUnsafe` throw even inside transactions; global `users` rows are reachable only through relations of bound tenant rows. Identity resolution before a tenant exists (login, membership listing, organization switch) uses the unguarded client inside `IdentityService` with explicit `userId`/`organizationId` binding.

### 4.4 Tenancy checklist (applies to every feature)

| Surface | Rule | Verified by |
|---|---|---|
| API requests | `activeOrgId` from session only; schemas `.strict()` reject `organizationId`; foreign IDs → 404 | Cross-tenant HTTP suite |
| Repositories | Tenant-scoped repository per model; guard extension active in all environments | Guard unit tests; repository integration tests |
| Background jobs | Payload carries `organizationId`; processor runs inside a CLS tenant context built from it and re-validates the target row's `organization_id` | Worker tests with mismatched org payload → job fails permanently, no write |
| SSE / pub-sub channels | Channel names include `org:<orgId>`; a connection subscribes only to its session's active org; payloads carry IDs only | `apps/api/test/realtime.int.test.ts`: the same user's Org-B events never reach their Org-A stream; non-ID payloads dropped (Phase 3) |
| Redis keys | Tenant data keys prefixed `…:<orgId>:…` (sessions are user-scoped and store `activeOrgId`); no unprefixed tenant keys | Key-builder unit tests; code review |
| Dashboard caches | Key `dash:v1:{orgId}:{dashboard}:{scopeHash}:{versionsHash}`; never shared across orgs or scopes; permission checked before every read | `dashboard.security.int.test.ts` cache security (Phase 8, §15h) |
| Search | Every search query bound to `organization_id` and filtered by each entity's list scope in SQL | `dashboard.security.int.test.ts` search security, tenant both ways (Phase 8, §15h) |
| Attachments | Storage key prefixed `org/<orgId>/`; download authorizes the owner resource in tenant context; pre-signed URLs issued only after authz | Org-B attachment download → 404 |
| Webhooks | Tenant resolved from the verified binding (Jira connection / GitHub installation row), never from payload fields; each mapping resolves only within that org | Webhook from Org-B binding cannot mutate Org-A |
| Outbox processing | `outbox_events.organization_id` required; consumers re-load data in that org's context | Outbox relay tests |
| Scheduled jobs | Sweeps iterate organizations explicitly and enqueue per-org jobs; no cross-org query without an explicit org loop | Scheduler tests |
| Audit access | `audit_logs` read only via tenant-scoped repository with `audit.view`; platform logs only via platform endpoints | Audit cross-tenant tests |

### 4.5 Mandatory negative tests (Phase 1 and every later phase)
- **Read**: Org-A session + Org-B resource ID → `404` for every detail endpoint.
- **List**: list endpoints never include Org-B rows, including with forged filter values (`projectId`, `assigneeId` of Org-B).
- **Create relationship**: creating an entity that references an Org-B ID (e.g. ticket with Org-B `projectId`, member role with Org-B `roleId`) → `404`/`422`, no row written.
- **Update relationship**: changing a reference to an Org-B ID → rejected, unchanged row.
- **Database**: a direct insert with mismatched `organization_id` across a composite FK fails (constraint test).
- **Payload**: body containing `organizationId` → `400 VALIDATION_FAILED`.
- **Raw SQL**: each statement in `platform/db/sql/` tested with two orgs.

## 5. Input, output and transport

- **Validation**: Zod `.strict()` schemas via NestJS Standard Schema pipe (ADR-0004); string length caps; enum allow-lists for sort/filter fields.
- **Output**: explicit response schemas; React escaping; markdown via sanitizing renderer (`react-markdown` + `rehype-sanitize`); no `dangerouslySetInnerHTML`.
- **Headers** (helmet + Next config): CSP with nonces, `frame-ancestors 'none'`, HSTS (prod), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self), camera=(self)`.
- **CORS**: same-origin by default; explicit allow-list via `CORS_ORIGINS`.
- **TLS** at the reverse proxy; HTTP → HTTPS redirect; internal Docker network.
- **Rate limiting**: two layers. The API buckets below (Redis-backed, per IP or per user) are the policy; the production proxy adds per-IP flood limits in front of them (table after the API buckets). Both answer `429 RATE_LIMITED` with `Retry-After`.
- **Request limits**: JSON body 1 MB; uploads go directly to storage via pre-signed PUT.
- **As implemented (Phase 1)**: helmet with an API-only CSP (`default-src 'none'`, `frame-ancestors 'none'`) and Swagger's default CSP on the docs path only; `X-Powered-By` removed; `trust proxy` = `TRUST_PROXY_HOPS`; CORS only for `CORS_ORIGINS` (credentials allowed); JSON 1 MB, urlencoded 16 KB. The web app sets a per-request nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-eval` in production) in `proxy.ts`.
- **Rate limiting as implemented** (ADR-0016): Redis storage (atomic Lua `INCR`/`PEXPIRE`), keys `ops:rl:<bucket>:<hash>`, over-limit → `429 RATE_LIMITED` with `Retry-After`. All limits are per minute and configurable:

  | Bucket | Key | Applies to | Variable (default) |
  |---|---|---|---|
  | `default` | client IP | every route except health and webhooks | `RATE_LIMIT_DEFAULT_PER_MINUTE` (300) |
  | `auth` | client IP | additionally `auth/login`, `auth/step-up`, `auth/callback` | `RATE_LIMIT_AUTH_PER_MINUTE` (20) |
  | `webhook` | source IP | inbound webhooks only (`auth/backchannel-logout` now; Jira/GitHub later), separate from browser buckets | `RATE_LIMIT_WEBHOOK_PER_MINUTE` (600) |
  | `user` | SHA-256 of the user id | every authenticated request, across sessions and IPs | `RATE_LIMIT_USER_PER_MINUTE` (240) |
  | `sensitive` | SHA-256 of the user id | additionally role grant/revoke, organization settings, employee create/status/invitation | `RATE_LIMIT_SENSITIVE_PER_MINUTE` (20) |
  | `upload` | SHA-256 of the user id | additionally attachment upload intents | `RATE_LIMIT_UPLOAD_PER_MINUTE` (30) |
  | `jira` | SHA-256 of the user id | additionally every route that calls Jira or queues Jira work: project search, mapping writes, run request/cancel/retry, ticket issue search, issue types, link/unlink, issue create (Phase 4); protects the organization's shared Jira quota | `RATE_LIMIT_JIRA_PER_MINUTE` (30) |
  | `github` | SHA-256 of the user id | additionally every route that calls GitHub or queues GitHub work (Phase 5) | `RATE_LIMIT_GITHUB_PER_MINUTE` (30) |
  | `attendance` | SHA-256 of the user id | additionally check-in and check-out (Phase 7) | `RATE_LIMIT_ATTENDANCE_PER_MINUTE` (10) |
  | `search` | SHA-256 of the user id | additionally global search (Phase 8) | `RATE_LIMIT_SEARCH_PER_MINUTE` (60) |
  | `sensitive` (Phase 9) | as above | also custom role create/update/delete | as above |

  **Proxy layer (Phase 9, `infra/nginx/prod`)**, keyed by the connecting address: `/api/` and the web app 50 r/s, burst 200; `auth/login` and `auth/callback` 30 r/min, burst 20; Keycloak `/auth/` 10 r/s, burst 50; webhooks 20 r/s, burst 100; 100 concurrent connections per address. The API answers 429 well before these trigger for a single user. The proxy limits only stop floods before they reach Node. Rejections use the API's JSON envelope (`snippets/api-errors.conf`). The measured thresholds are in `docs/runbooks/performance.md`.

  Integration tests prove the 429s, that one user exhausting a bucket does not affect another user or IP, that webhooks do not consume the auth bucket, and that Redis keys never contain raw user, organization, subject or session identifiers. **As implemented (Phase 7)**: check-in and check-out share a per-user bucket (`RATE_LIMIT_ATTENDANCE_PER_MINUTE`, default 10 per minute). A replay with the same `Idempotency-Key` returns the original outcome (`200`) and stores nothing new, so a client retrying a lost response is safe; only a burst beyond the bucket gets `429` with `Retry-After`, after which the same key still replays.
- **Client IP and forwarding headers**: the API derives the client IP with `trust proxy = TRUST_PROXY_HOPS`. Nginx routes `/api` directly to the API and appends the connecting address to `X-Forwarded-For` (`TRUST_PROXY_HOPS=1`, so only that rightmost entry is trusted). Where the Next.js server forwards `/api` itself (development, E2E, deployments without Nginx), `proxy.ts` deletes `Forwarded`, `X-Forwarded-*` and `X-Real-IP` from the client request, so a client cannot choose its own rate-limit key; a unit test covers this.
- **Logging**: pino with redaction of `authorization`, `cookie`, `set-cookie`, `x-csrf-token`, OIDC `code`/`state` query values and any `password`/`secret`/`token`-like key at the top level or one level deep; request bodies are not logged. A test runs a real HTTP request through the logger and asserts none of these values reach the output.

## 6. Files

1. Client requests an upload intent (`POST /api/v1/attachments/uploads`) → API authorizes against the owner resource, validates size/type allow-list, creates a `PENDING_UPLOAD` row, returns a pre-signed PUT URL (5 min) with fixed `Content-Type` / `Content-Length`.
2. Client uploads directly to storage.
3. Client confirms (`POST /api/v1/attachments/:id/complete`) → API `HEAD`s the object, re-checks size, sniffs magic bytes (`file-type`), marks `AVAILABLE` or `REJECTED` + deletes.
4. Download: `GET /api/v1/attachments/:id/download` authorizes then 302s to a 60-second pre-signed GET with `Content-Disposition` from the sanitized filename.
- Default allow-list: JPEG, PNG, WebP, HEIC, PDF, plain text, CSV, XLSX, DOCX; ZIP optional per org. Default max 25 MB.
- Private bucket; no public ACLs; bucket paths never sent to clients.
- **As implemented (Phase 1)**: `POST /api/v1/attachments/upload-intents` (per-user `upload` rate limit) authorizes the owner resource (first consumer: employee avatar, `employee.manage` or own profile), checks declared type and size against the allow-list above (25 MB, ZIP off), and returns a pre-signed PUT valid for 300 s with a signed `Content-Type`. Storage keys are server-generated (`org/<orgId>/<owner-type>/<uuid>`) and never derived from the file name. `POST /:id/complete` streams the object once, enforcing the size cap, computing SHA-256 and sniffing magic bytes (`file-type`; OOXML may sniff as ZIP; text/CSV must be valid UTF-8 without NUL), then runs the `AttachmentScanner` port (no-op adapter in Phase 1) and marks the row `AVAILABLE` or `REJECTED` (object deleted). `GET /:id/download-url` re-authorizes the owner in the active organization and returns a 60 s pre-signed GET with a sanitized `attachment` disposition. Expired pending uploads are deleted by a worker job. Foreign-organization attachment IDs return `404`.
- **As implemented (Phase 2)**: second owner type `DAILY_REPORT`.
  - **Limits:** JPEG, PNG, WebP and PDF up to 10 MB.
  - **Upload:** the reporter only, while the project is neither COMPLETED nor ARCHIVED.
  - **View:** whoever can view the report.
  - **Delete:** the reporter or a `project.manage` holder on the project, unless the project is archived.
  - **Listing:** `GET /attachments?ownerType=&ownerId=` lists only owner types declared listable, so avatars cannot be enumerated.
  - **Deletion:** `DELETE /attachments/:id` and avatar replacement or removal mark the previous file `DELETED` (audited) and enqueue `attachment.object.delete`. The worker removes the object using the key stored in the row of the event's own organization (never a key from the payload).
  - **Malware scanning (Phase 9 decision):** not included in V1. Uploads are stored as `NOT_SCANNED` behind the `AttachmentScanner` port; the mitigations and the path to a scanner are in §15i.
  - **Browser:** uploads go straight to `S3_PUBLIC_ENDPOINT`. The web CSP adds only that origin (`STORAGE_PUBLIC_ORIGIN`) to `connect-src` and `img-src`, and bucket CORS must be limited to `APP_PUBLIC_URL` in production (`DEPLOYMENT.md` §6).

## 7. Secrets and encryption

- Secrets from environment variables / Docker secrets (`*_FILE` variants). `.env.example` contains placeholders only. Secret scanning (gitleaks CLI) in CI.
- **Integration tokens** (Jira OAuth access/refresh tokens) are encrypted with **AES-256-GCM** (random 96-bit IV, AAD = `organizationId|connectionId|field`). Master key `APP_ENCRYPTION_KEY` (32 bytes, base64) from a secret; envelope stores `keyId` for rotation (`APP_ENCRYPTION_KEYS_PREVIOUS`).
- GitHub App private key, GitHub webhook secret and Jira OAuth client secret are **deployment secrets**, not DB values.
- **As implemented (Phase 4)**: envelopes are `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url) (a DB CHECK enforces the `v1.` prefix on both token columns); the API and the worker must share `APP_ENCRYPTION_KEY` (the API encrypts at consent, the worker decrypts and rotates). Tokens are decrypted only inside `JiraClient`/`JiraTokenManager`, never returned by any endpoint (API tests assert that no response contains token material), and wiped on disconnect cleanup. Undecryptable tokens (lost key) move the connection to `NEEDS_REAUTH` instead of failing repeatedly.
- **As implemented (Phase 5)**: the GitHub App private key, client secret and webhook secret come only from the environment or `*_FILE` mounts (`DEPLOYMENT.md` §6) and are held in memory. App JWTs (540 s) are signed in memory; installation tokens are never written to the database, are cached in memory and as AES-256-GCM envelopes in Redis (shared by API and worker) until 5 minutes before `expires_at`, and are created under a per-installation lock. The setup flow's GitHub user token lives for one request and is revoked. No endpoint returns or accepts any of these values (API tests scan every response for key material, secrets and `ghs_`/`ghu_` tokens), and they are not logged or audited.
- Logs: pino redaction paths + serializer that strips query strings containing `code`, `state`, `token`.
- Audit metadata passes through a redactor dropping keys matching `/(secret|token|password|authorization|cookie|private_?key)/i`.

## 8. Database least privilege

- `ops_migrator`: DDL, migration job only. In development/test it also has `CREATEDB` so `prisma migrate dev` can create its shadow database; production roles are provisioned without it (`DEPLOYMENT.md` §9).
- `ops_app`: DML on application tables; **no** `UPDATE`/`DELETE` on `audit_logs`, `platform_audit_logs`, `*_events`. Retention purge runs as a dedicated function invoked only for configured policies.
- **As implemented (Phase 1)**: the first migration revokes `UPDATE`, `DELETE`, `TRUNCATE` on both audit tables and all access to `_prisma_migrations` from `ops_app`, and adds `BEFORE UPDATE OR DELETE` / `BEFORE TRUNCATE` triggers so even the owner cannot rewrite audit history. Integration tests prove `ops_app` cannot `CREATE`/`ALTER`/`DROP` tables, create functions, truncate, disable triggers or read migration history.
- `ops_backup` (Phase 9, replaces the planned `ops_readonly`): `CONNECT` on both databases plus `pg_read_all_data` for `pg_dump`. It runs in the backup service and can write nothing.
- Keycloak uses its own database and user (`keycloak`), with no access to the application database.
- **As implemented (Phase 9)**: production roles are created by the Postgres init script with passwords from secret files. `ops_migrator` has no `CREATEDB`, and `ops_app` is not a superuser, has no `BYPASSRLS` and owns no tables. The `postgres` superuser is used only for initialization and restore. 19 integration tests prove the boundaries (`packages/core/test/platform/production-roles.int.test.ts`; `docs/runbooks/database-roles.md`). The connection budget is 10 per API or worker process and 100 for Keycloak. RLS was evaluated and not adopted for V1 (ADR-0025).

## 9. Attendance geolocation baseline

- Location captured only on explicit check-in/out; no background tracking or polling.
- The client **always sends `accuracy`** (meters) with coordinates; the server stores it on every attendance event.
- Server-side haversine distance vs `allowed_radius_meters`.
- **Poor accuracy is never treated as strong evidence.** If `accuracy > maxAccuracyMeters` (per-org setting; the setup UI suggests a value but no code default is treated as policy), the result is `LOW_ACCURACY` — never `INSIDE`, even if the reported point lies within the geofence.
- The organization chooses `lowAccuracyAction`: `FLAG_FOR_REVIEW` (baseline: record check-in with `review_status = PENDING_REVIEW`, reviewed by `attendance.admin` or `attendance.team` in scope) or `REJECT` (`422 ATTENDANCE_LOW_ACCURACY`, user can retry or submit a correction request).
- Location is **not** tamper-proof; results are evidence for dispute resolution combined with IP, user agent and server time. The UI states this and what is captured.
- Permission-denied and unavailable location are recorded as such (`PERMISSION_DENIED`), not silently accepted.
- **As implemented (Phase 7, ADR-0022)**: the browser reads the position once per explicit tap (no `watchPosition`, no automatic retry). The body is strict: status, latitude, longitude and accuracy only. Work location ids, distances, timestamps, organization and employee ids from the client are refused (`400`). The server picks the eligible locations (active offices, plus sites of ACTIVE projects the employee actively belongs to; never inactive or foreign rows), computes the haversine distance and uses its own clock. Coordinates are rounded to 5 decimals (about 1 m) and stored only on the event; they never appear in API responses, errors, exports, notifications or logs (the shared pino redaction list covers `latitude`, `longitude` and `location`). The UI says what is captured and that a location can be wrong or spoofed. There is no code default for the accuracy policy: until an administrator saves it, location check-ins are refused (`409 ATTENDANCE_NOT_CONFIGURED`). Approved remote work and business missions need no location and store none. IP address and user agent are stored on the event and shown to `attendance.admin` only.

## 10. Webhook security

- **GitHub**: verify `X-Hub-Signature-256` (HMAC-SHA256, webhook secret) over the **raw** body in constant time before parsing; reject if missing. Idempotency by `X-GitHub-Delivery`.
- **Jira Cloud (OAuth 2.0 app dynamic webhooks)**: verify the JWT in the `Authorization` header (signed with the app's client secret) per Atlassian documentation; exact claim checks are confirmed in the Phase 4 spike. Reject unsigned requests.
- **As implemented (Phase 4, Atlassian webhooks documentation checked 2026-10-03)**: `Authorization: Bearer <JWT>`, HS256 only (no `none`, no other algorithm), HMAC over header.payload with `JIRA_OAUTH_CLIENT_SECRET` compared in constant time, `exp`/`nbf` enforced with 60 s leeway when present, at most 8 192 characters. Atlassian documents no further required claims. Because one secret signs deliveries for every connection of the app, the endpoint `POST /api/v1/webhooks/jira/:connectionId` also requires a live connection (`404` otherwise) and, when the payload names `matchedWebhookIds`, at least one registration of that connection (`403`). The tenant comes from the connection row only. Deliveries are deduplicated per connection by `X-Atlassian-Webhook-Identifier` (else a hash of event, issue and timestamp); only identifiers are stored, and the worker re-fetches the issue with that connection's token, so a replayed or forged body cannot inject data.
- **As implemented (Phase 5, GitHub webhook documentation checked 2026-10-03)**: `POST /api/v1/webhooks/github` captures the raw body before any parser, whatever the content type, with a byte cap (`GITHUB_WEBHOOK_MAX_BYTES`; declared and streamed oversize bodies `413`). `X-Hub-Signature-256` must be `sha256=` plus 64 hex characters and equal the HMAC-SHA256 of the raw bytes under `GITHUB_WEBHOOK_SECRET` (`timingSafeEqual`); missing, malformed or wrong → `401` before anything is stored. The SHA-1 `X-Hub-Signature` is never read. Headers and payload shape are then validated (`400`). Unknown installations and unsupported events are acknowledged without storing. The tenant comes only from the stored installation binding; deliveries are unique by `X-GitHub-Delivery`; only identifiers are stored; the worker re-fetches everything from GitHub with that installation's token, so a replayed or crafted body cannot inject data.
- Handlers: verify → persist delivery row (unique key) → enqueue → `202`. Duplicate → `200` no-op.

## 11. Retention and privacy

- Retention is **configurable per organization and data category** (`retention_policies`, `DATA_MODEL.md` §3).
- Proposed examples only (not applied automatically): attendance coordinates 24 months; audit logs 7 years.
- **No destructive retention job runs until a policy is explicitly configured** for that category. Absent a policy, data is retained.
- Configuring a policy requires `org.settings.manage` + MFA and is audited; the first purge after a policy change is preceded by a dry-run count shown to the admin.
- Data residency is a deployment policy (`DEPLOYMENT.md` §7).
- **As implemented (Phase 5, ADR-0020)**: policies exist for the technical categories `WEBHOOK_DELIVERIES` and `SYNC_FAILURES` (Jira and GitHub), 7–3650 days, managed through `/api/v1/organization/retention-policies` (`org.settings.manage` + MFA, optimistic versions, audited). Saving first shows a dry-run count (`GET …/{category}/preview`, deletes nothing) and needs a second confirmation. The daily worker pass calls the `SECURITY DEFINER` function `purge_integration_records`, which re-reads the policy, never removes deliveries still awaiting processing, deletes at most 5 000 rows per call oldest first, and records a system audit entry with the count. Audit history, Support↔Jira links, ticket↔PR links, PR↔Jira links, caches and runs are outside its reach, and the runtime role has no `DELETE` on those tables.

## 12. Error handling

- Global exception filter returns the standard envelope (`ARCHITECTURE.md` §8.1); unknown errors → `500 INTERNAL_ERROR` with `requestId` only.
- Third-party error bodies are never forwarded; mapped to codes such as `JIRA_UNAVAILABLE`, `JIRA_REAUTH_REQUIRED`.
- Production disables OpenAPI UI by default (`SWAGGER_ENABLED=false`).

## 13. Supply chain and CI

- Lockfile committed; `pnpm install --frozen-lockfile` in CI; minimum release age for new versions (setting confirmed against pnpm 12 docs in P1-1).
- `pnpm audit --audit-level high` over all dependencies (dev included; justified exceptions in `pnpm-workspace.yaml` `auditConfig.ignoreGhsas`, ADR-0015), Dependabot, gitleaks CLI v8.30.1, CodeQL (`github/codeql-action` v4.38.2, `security-extended`).
- Actions pinned by commit SHA. Docker images pinned by digest (`DEPENDENCIES.md` §6), non-root, no package manager in runtime images, Trivy scan (Phase 9).
- **As implemented (Phase 9)**:
  - **Image gate.** The CI job "Release images" validates every production Compose combination (base, with all overlays) and builds the api, worker, web and migrate images. It then fails on any **fixable HIGH or CRITICAL** Trivy finding (Trivy 0.75.0, checksum-verified download).
  - **Scan exceptions.** Exceptions live in `.trivyignore`, one advisory per line with an expiry date, and are justified in ADR-0015 alongside the matching `pnpm audit` exceptions.
  - **SBOMs.** CI publishes CycloneDX SBOMs for each image as the `sbom` artifact.
  - **Third-party images.** Pinned images (PostgreSQL, Redis, Keycloak, nginx, SeaweedFS) are scanned report-only. Their findings belong to the upstream image, and we fix them by moving the pin to a patched digest at the next release, not by patching vendor images ourselves.
  - **Runtime image.** The application runtime image runs `apt-get upgrade` at build time to pick up Debian security fixes, then runs as `node`.
  - **Containers.** Production containers drop all capabilities and set `no-new-privileges`; filesystems are read-only where the image allows it. PostgreSQL runs as uid 999 from the start, so the entrypoint never runs as root.
  - **Secret scanning.** gitleaks scans the full history and the working tree with `--redact`.
- pnpm is installed via the official pnpm installation instructions (`DEPLOYMENT.md` §2); docs and CI do not depend on Corepack.

## 14. SUPER_ADMIN (ADR-0010)

- Platform role on `users.platform_role`; not an organization role; not equivalent to ORG_ADMIN.
- No implicit tenant bypass: guard extension and scoped repositories apply identically.
- Platform endpoints (deferred) return organization metadata only; actions logged in `platform_audit_logs`.
- Cross-tenant support access only via deferred `support_access_sessions` (reason, optional ORG_ADMIN approval, ≤ 60 min, read-only, bannered, dual audit).
- MFA mandatory (§2.3). First organization is created by an audited CLI bootstrap command.
- **Phase 9 review**: nothing in V1 reads or writes `users.platform_role`. No platform endpoint, support-access session or bootstrap path grants it, so the role has no effect in V1 (§15i).

## 15a. Phase 1 internal security review (2026-10-02)

Scope: everything implemented in Phase 1. Each property is backed by the named automated test; items marked **fixed** were found during the review.

| Area | Result | Evidence |
|---|---|---|
| Tenant isolation | Foreign ids are 404 for read/update/link at service and HTTP level; lists exclude other orgs; composite FKs reject cross-org rows in every tenant table; guard fails closed without context | `tenant-isolation.security`, `people-rbac.security`, `platform-services`, `http-security` (Org A/Org B), E2E org switch (cross-tenant 404) |
| Authorization / scopes | SELF/TEAM/DEPARTMENT/ORG resolved in core; list filters and mutations use the same policy; employee gets 403 on admin APIs | `authorization`, `people-rbac.security`, E2E permissions |
| Role escalation | Delegated role managers cannot grant/revoke admin-equivalent roles or change their own; admins cannot change their own roles; last active ORG_ADMIN cannot be disabled; grants require MFA and are audited | `people-rbac.security`, `http-security` (MFA) |
| Organization switch | Only own ACTIVE memberships; unknown/foreign → 404; forged bodies rejected; session id and CSRF token rotate; audited | `http-security`, E2E org switch |
| Session fixation | Login, step-up, switch and authz changes rotate the id; pre-existing cookie discarded at login | `keycloak-oidc` (fixation), `session-store` |
| CSRF / Origin | Unsafe methods need allow-listed `Origin` and the synchronizer token; CORS allow-list only | `http-security` |
| Rate limits | Per-IP and per-user buckets, stricter sensitive/upload/auth buckets, separate webhook bucket, 429 + `Retry-After`, principal and IP isolation, spoofed `X-Forwarded-For` ignored without trusted hops. **Fixed**: back-channel logout moved from the browser `auth` bucket to a dedicated `webhook` bucket; the web `/api` proxy now strips client forwarding headers | `rate-limit`, `http-security`, `apps/web/test/proxy.test.ts` |
| Keycloak / OIDC | Confidential client, PKCE required, password/implicit grants off, redirect URIs exact; state/nonce single-use; replay and forged state rejected; back-channel logout token fully validated; ORG_ADMIN MFA at login; step-up | `keycloak-oidc`, E2E auth and MFA step-up |
| Audit immutability | `ops_app` lacks UPDATE/DELETE/TRUNCATE; owner blocked by triggers; audit API tenant-scoped behind `audit.view` (privileged, MFA) | `tenant-isolation.security`, `features` (audit), E2E permissions |
| Attachment access | Server-generated org-prefixed keys; owner re-authorized on every URL issue; uploader-only completion; magic-byte, size and type checks; cross-tenant 404 | `platform-services` (attachments) |
| Unsafe raw SQL | `$queryRawUnsafe`/`$executeRawUnsafe` banned by lint and rejected at runtime; tagged raw SQL only in `platform/db/sql/` with explicit `organization_id` | `raw-sql-lint-policy`, `tenant-isolation.security` |
| Secret logging | **Fixed**: top-level `password`/`secret`/`token` keys were not redacted (only nested ones); now both are. Cookies, authorization, CSRF and OIDC query values verified absent | `apps/api/test/logging.test.ts` |
| Production/test boundaries | Former security-probe routes removed (404 test); dev seed refuses production and needs `ALLOW_DEMO_SEED`; http issuer forbidden in production; Swagger off in production; bootstrap CLI in production requires `--confirm-production <slug>` | `http-security`, `provisioning-and-seed`, `env` |
| DB privileges | Runtime role has DML only; no DDL, functions, trigger disabling or migration-history access | `tenant-isolation.security` |
| Redis key separation | All keys under `ops:<namespace>:`; identifiers hashed; BullMQ under `bull:` | `rate-limit` (namespaces) |
| SSE | Not implemented in Phase 1 (Phase 3, P3-10); the §4.4 SSE row applies then | — |
| Outbox job tenant context | Relay derives the tenant from `outbox_events.organization_id`; payloads cannot target another tenant; foreign recipients fail permanently; deterministic job ids make delivery idempotent | `outbox-worker`, `platform-services` (notifications) |

Residual risks (accepted, tracked): RLS not enabled (ADR-0003, P9-7); attachment malware scanning is a no-op port until a scanner is chosen (P9-3); three dev/tooling-only advisories ignored with justification (ADR-0015).

## 15b. Phase 2 internal security review (2026-10-03)

Scope: customers, projects, membership, work locations, daily reports and their attachments, missing-report derivation and notifications, the activity read model, the upload widget and employee photos. Decisions: ADR-0017.

| Area | Result | Evidence |
|---|---|---|
| Tenant isolation | Composite `(organization_id, id)` foreign keys on every Phase 2 relation reject cross-organization rows (P2003 asserted per relation); services bind every query to the active organization; foreign ids are 404; the activity consumer never links an event to another organization's project; rebuild is per organization | `projects.security` (composite keys, cross-org, rebuild), `apps/api/test/projects.int.test.ts` (Org A/Org B) |
| PROJECT scope | Reach = member, PM or TM; list filter and resource policy use the same rule; out-of-reach projects, reports, members, activity and attachments are 404; the employee project card only lists projects the viewer may see | `projects.security` (visibility and list filters), E2E flow 6 |
| Membership escalation | Project-scoped assigners cannot manage PM/TM roles, change themselves or add people whose PROJECT grants exceed their own; disabled/terminated people cannot be added; changes are audited | `projects.security` (membership rules) |
| Lifecycle and integrity | Allowed status transitions only; archive/restore need ORG-wide `project.manage`; archived projects are read-only; optimistic concurrency on every project mutation; codes from a locked counter (concurrency test); unique report per project/reporter/date | `projects-domain`, `projects.security` |
| Daily reports | Only project staff with `daily_report.submit`; no future dates, 7-day backfill, no edits; SELF/TEAM/DEPARTMENT/PROJECT viewing via report facts; timeline hides report entries from callers without `daily_report.view` | `projects.security` (daily reports, activity) |
| Attachments | Owner policy per type; content sniffing rejects SVG/HTML disguised as images; cross-tenant and out-of-scope 404; uploader-only completion. **Fixed**: replaced or removed employee photos stayed `AVAILABLE` and could be listed through `GET /attachments` and downloaded by anyone allowed to view the employee; they are now retired (`DELETED`, object deletion queued) and avatars are not listable | `platform-services` (retires replaced and cleared photos), `projects.security` (attachments), E2E flow 9 |
| Input validation | Strict Zod schemas with length caps; allow-listed sorts/filters; date ranges capped (31 days). **Fixed**: a forged pagination cursor with a non-UUID id reached PostgreSQL and surfaced as `500 INTERNAL_ERROR`; cursors now require a UUID tie-breaker and fail with `400 VALIDATION_FAILED` (applies to every keyset list, Phase 1 included) | `projects.security` (forged cursors) |
| Notifications | Outbox-only; dedupe keys per project/member and per project/reporter/date, so retries and re-runs never duplicate; recipients re-validated in the event's organization | `projects.security` (missing check), `outbox-worker` |
| Browser | CSP adds only the storage origin; no `dangerouslySetInnerHTML`; report text rendered as text; activity rendered from typed parameters, not server prose | `apps/web/test/proxy.test.ts`, lint |

Residual risks (accepted): an uploader keeps access to files they uploaded after leaving the project (their own content, by id only); project-scoped project managers can read the organization's customer list (needed to pick a customer; customer contacts are business contacts); outbox events are retained indefinitely so timelines stay rebuildable (a retention policy must exempt or snapshot them).

## 15c. Phase 3 internal security review (2026-10-03)

Scope: support tickets, taxonomies, assignment, comments and internal notes, watchers, history, SLA policies, calendars and the sweep, escalation rules, ticket attachments, email delivery, Server-Sent Events and the project Support tab. Decisions: ADR-0018. Items marked **fixed** were found during Phase 3 testing or this review and have regression tests.

| Area | Result | Evidence |
|---|---|---|
| Tenant isolation | Composite `(organization_id, id)` FKs on every Phase 3 relation reject cross-organization rows (P2003 asserted for tickets, comments, watchers, history, SLA events, components and the project support team); services bind every query to the active organization; foreign tickets, comments and attachments are 404 | `support.security` (composite keys, foreign tickets and attachments) |
| Ticket visibility | ORG/DEPARTMENT/PROJECT/TEAM/SELF scopes from `support.view`; list filters and resource checks share one predicate; out-of-scope reads 404, visible-but-not-permitted actions 403. **Fixed**: a field employee (PROJECT-scoped grants) lost access to the project-less ticket they had just reported; reporters now keep view/comment/verify on their own tickets, and nothing more | `support.security` (reporter rule, unrelated colleague 404), E2E scenarios 1, 8, 16 |
| Internal notes | Returned only to `support.internal_note` holders; excluded from reporter comment lists, history, notifications, emails and errors; a forged internal note from a reporter is 403; editing someone else's note is 404; audit stores ids only | `support.security` (note secrecy across every read path), E2E scenario 5 (UI and API) |
| Assignment | Only active, actively employed members who can view and comment on the ticket in their own right; team membership enforced; archived teams rejected; audited | `support.security` (assignment eligibility), E2E scenario 3 |
| Lifecycle | Server-side state machine; transitions re-checked per permission; resolve, verify and close are distinct; locked tickets reject comments, files and edits (409); optimistic concurrency on every mutation | `support-domain`, `support.security`, E2E scenarios 11–13 |
| Taxonomy leakage | **Fixed**: project-scoped component names were listed to everyone; without a project only global components are returned, and a project's components require visibility of that project (404 otherwise) | `support.security` (component scoping) |
| Attachments | Owner policy re-checks the ticket on every intent, list, download and delete; content sniffing; 10 MB cap; IDOR attempts on ticket and attachment ids are 404. **Fixed**: completed and removed attachments were not recorded in the ticket history; they now are, in the same transaction | `support.security` (attachments, history entries), E2E scenario 6 |
| Input validation and pagination | Strict Zod schemas with length caps; allow-listed views, filters and sorts; forged or tampered cursors are 400; idempotency keys are per reporter and reject conflicting replays (409) | `support.security` (cursors, idempotency), `support-domain` |
| SLA and escalation | Sweep runs per organization in a system tenant context; conditions and escalations are recorded once (partial unique index) and notifications use deterministic dedupe keys, so retries never spam; breaches stay sticky | `support.security` (sweep), `apps/worker/test/support-worker.int.test.ts` |
| Email | Rendered from notification type and parameters only (never comment bodies or notes); HTML-escaped; single-line subjects (no header injection); links built from `APP_PUBLIC_URL` and the entity id; inactive recipients skipped; one delivery per notification, never re-sent after `SENT`; errors truncated and stored without secrets | `notification-job`, `support-worker.int` (Mailpit), E2E scenario 16 (exactly one email, no note text) |
| Server-Sent Events | Channels built only on the server from the session; the support queue channel only for ORG-wide `support.view`; payloads validated as identifiers-only; session re-checked every minute; five streams per user. **Fixed**: the per-user limit answered with a `200` stream carrying an error event, and a client that left during setup could leak a slot; the limit is now a guard (`429` before the stream starts) and slots are taken and released with the stream subscription | `apps/api/test/realtime.int.test.ts` |
| Browser | Comments and descriptions rendered as plain text; history localized from typed parameters; no `dangerouslySetInnerHTML`; the create form re-validates file type and size before upload | lint, E2E |
| Performance and privacy | No per-person metrics, rankings or resolution-time tables; project counts are scoped to the viewer and 404 for members who cannot see the project | `support.security` (project manager visibility), E2E scenario 7 |

Residual risks (accepted): an email already queued when a recipient loses access is still delivered (it carries only the ticket key and title, like the in-app notification); public replies can be edited by their author without a stored previous version (the edit is recorded in history and audit, the old text is not); the per-user stream limit is per API process, so N replicas allow 5 × N streams; malware scanning is still the no-op port (P9-3).

**Phase 4 updates to Phase 3 residuals.** *Queued email:* closed. Immediately before claiming a delivery, the worker re-evaluates the recipient's access to the notification's subject (for example the ticket) against current grants; if it is gone the delivery becomes `SUPPRESSED` (reason code only), a terminal, non-error state that is never retried or sent. Recipients who are no longer active members stay `SKIPPED` as before (`apps/worker/test/support-worker.int.test.ts`). *Stream limit:* documented scope (ARCHITECTURE §11): the five-streams-per-user limit is process-local resource protection, not a tenant-isolation or security boundary; a global cap under horizontal scaling would need a distributed limiter, deliberately not built now.

## 15d. Phase 4 internal security review (2026-10-03)

Scope: Jira connection (OAuth 3LO, site selection, tokens), project mappings, sync runs and the worker, webhook intake and processing, the ticket Development panel (search, link, unlink, create), the project Jira tab and the admin screens. Decisions: ADR-0019. Items marked **fixed** were found during Phase 4 testing or this review and have regression tests. Evidence names refer to `packages/core/test/jira/jira.security.int.test.ts` (`jira.security`), `packages/core/test/jira/jira-adapter.test.ts` (`jira-adapter`), `apps/api/test/jira.int.test.ts` (`api jira`), `apps/api/test/rate-limit.int.test.ts` and `apps/e2e/tests/09-jira.spec.ts` (E2E flows 1–17).

| Area | Result | Evidence |
|---|---|---|
| OAuth state binding | 32 random bytes, stored hashed with a 10-minute TTL, consumed once, bound to organization, member and user; a state replayed, forged, expired or completed by another administrator is rejected and creates nothing | `jira.security` (connection), `api jira` (forged state, state stolen by another admin) |
| Callback handling | Requires the same signed-in `integration.manage` session; always redirects to the fixed admin path with an allow-listed outcome code (never the code, token or upstream error text); `Cache-Control: no-store`; denied consent and missing parameters map to distinct codes | `api jira` (deny, missing parameters, forged state) |
| Token encryption | AES-256-GCM with AAD per organization, connection and field (a copied ciphertext does not decrypt); key rotation; tokens never in responses, logs, audit or errors | `jira-adapter` (token bound to organization, connection and field; retired-key envelopes), `api jira` (`ok()` asserts no token strings in every response), `jira.security` |
| Refresh races | Per-connection lock, row re-read after acquiring it, rotated refresh token stored with the access token in one versioned update; a concurrent refresh never loses the rotated token; `invalid_grant` → `NEEDS_REAUTH` once | `jira.security` (racing refresh callers, NEEDS_REAUTH once on revocation), `jira-adapter` (lock holder, TTL expiry, rejected refresh = lost grant) |
| SSRF-like URL handling | API base and auth base are fixed (env-validated, Atlassian's in production); cloudId and site URL come only from `accessible-resources`; only `https` sites; no URL from a Jira response is fetched; deep links are `siteUrl/browse/<encoded key>`; JQL uses numeric ids and escaped text only | `jira-adapter` (numeric project ids only, user text never becomes JQL syntax, https relaxed only for the test double), env tests |
| Tenant cross-binding | Webhook tenant from the connection row only; every job re-scoped to the outbox event's organization and re-reads its rows there; composite `(organization_id, id)` FKs on all nine Jira tables; links only to issues of mappings of the ticket's own project | `jira.security` (tenant isolation of every Jira table, foreign connection cleanup skipped), `apps/worker/test/jira-jobs.test.ts` |
| Webhook verification | HS256-only JWT, constant-time compare, size cap, `exp`/`nbf`; connection and registered-webhook binding (`404`/`403`); malformed bodies `400` without detail | `jira-adapter` (missing, malformed, forged, unsigned and expired tokens), `jira.security` (unsigned, forged, unknown-connection and foreign-webhook deliveries), `api jira` (401/403/404/400) |
| Webhook replay | Per-connection unique delivery key; duplicates `200` with no new work; processing re-fetches from Jira and the upsert ignores older `updated`, so replays and out-of-order deliveries cannot regress data | `jira.security` (webhooks), `api jira` (duplicate) |
| IDOR | Foreign or out-of-scope tickets, links, runs, mappings and connections are `404`; ticket reporters without `jira.view` get `visible:false` and `403` on search; GM (view only) cannot link, create or unlink | `api jira` (fieldTmp, gm), `jira.security` (ticket links), E2E flows 14–15 |
| Internal-note leakage | Jira history events and the panel are hidden from viewers without `jira.view`; internal notes are never part of the panel, search results or create payload | `jira.security`, E2E flow 12 (fake Jira payload lacks the note text and attachments) |
| Create-issue payload | Only the user-confirmed summary/description (prefilled from the public description) plus a ticket back-link; reservation-based idempotency (same key + different body `409`); `POST /issue` never retried; interrupted attempts become `UNKNOWN` | `api jira` (idempotency replay and conflict, sub-task rejected), `jira.security`, E2E flow 12 |
| Logs | Jira errors carry a classification, status and rejected field **names** only; response bodies are never logged or stored; the webhook rejection log has the connection id only; pino redaction covers `authorization` | `jira-adapter` (error classification), code review |
| Browser-visible secrets | The browser sees the authorize URL (client id is public by design), the redirect URI and the site URL; never tokens, the client secret or the grant's token set; the connect response and the callback are `no-store` | `api jira`, E2E flow 1–2 (no tokens in API bodies) |
| Unauthorized sync controls | Runs, cancel, retry, failures and mappings require ORG-wide `integration.manage` (support and PROJECT-scoped holders `403`) | `api jira` (support 403 on runs), E2E flow 15 |
| Mapping privilege escalation | `integration.manage` is privileged: **fresh MFA required** (`401 MFA_REQUIRED` otherwise); only ORG-wide holders; mapping targets must be the organization's own projects (composite FK) and a Jira project maps to one project; audited | `api jira` (MFA step-up, VALIDATION_FAILED for non-id targets, duplicate CONFLICT), `jira.security` |
| Quota abuse | **Fixed**: routes that call Jira live had only the general per-user limit, so one user could drive the organization's connection into Atlassian rate limiting (pausing sync for everyone). A per-user `jira` bucket now applies; the admin Jira project picker also debounces typing (300 ms) instead of calling Jira per keystroke | `apps/api/test/rate-limit.int.test.ts` (Jira bucket) |
| Disconnect/reconnect race | **Fixed**: `jira.connection.cleanup` deleted every webhook registration of the connection; if the administrator reconnected the same site before the job ran, the new session's webhook could be deleted. Cleanup now only removes registrations created at or before the disconnect | `jira.security` (cleanup racing a reconnect) |

Residual risks (accepted): the integration has **not been exercised against a live Jira Cloud site** (DEPLOYMENT §6 checklist before production); a webhook JWT without `exp` is accepted (Atlassian does not document `exp` as mandatory), mitigated by delivery dedupe, connection/webhook binding and re-fetching; `jira_webhook_deliveries` and `jira_sync_failures` are retained without pruning (identifiers and short codes only); the cached issue summaries and assignee display names are visible to every `jira.view` holder in scope, mirroring Jira's own project visibility for the connecting account rather than each viewer's Jira permissions.

## 15e. Phase 5 internal security review (2026-10-03)

Scope: GitHub App configuration, installation setup and binding, App JWT and installation tokens, repository discovery and mappings, webhook intake and processing, sync runs and reconciliation, Jira key inference and manual links, the project GitHub tab, the ticket pull-request panel, the admin screen and retention of technical records. Decisions: ADR-0020. Items marked **fixed** were found during Phase 5 testing or this review and have regression tests. Evidence names refer to `packages/core/test/github/github.security.int.test.ts` (`github.security`), `packages/core/test/github/github-adapter.test.ts` (`github-adapter`), `apps/api/test/github.int.test.ts` (`api github`), `apps/api/test/github-raw-body.test.ts` (`raw body`), `apps/worker/test/github-jobs.test.ts` (`github jobs`) and `apps/e2e/tests/10-github.spec.ts` (E2E flows 1–17).

| Area | Result | Evidence |
|---|---|---|
| Private key and secret leakage | Secrets from env/`*_FILE` only; unusable keys rejected without echoing key material; no response, delivery row, audit entry or log contains the key, secrets, JWTs or tokens | `github-adapter` (unusable keys), `github.security` (secret hygiene), `api github` (`ok()`/`failure()` scan every body) |
| Webhook forgery | Raw-byte HMAC-SHA256 with constant-time compare, GitHub's test vector; missing, wrong, altered and SHA-1-only signatures `401` before storing; a `text/plain` body is still verified on its exact bytes | `github-adapter` (signatures), `github.security` (webhooks), `api github` (webhook receiver), `raw body` |
| Replay and redelivery | Unique `X-GitHub-Delivery`; duplicates `200` with no new work; a manual redelivery of a failed delivery is re-queued; processing re-fetches and guards on `updated_at` and on summary fetch time, so replays and reordering converge | `github.security` (dedupe, redelivery, older snapshot), `api github` (duplicate `200`) |
| Body size / resource use | Declared and streamed oversize bodies `413` before buffering beyond the cap; IP rate limit on the receiver | `raw body`, `api github` (413) |
| Installation cross-binding | A bare or forged `installation_id`, a forged state, a state from another session, and a GitHub user who cannot see the installation never bind anything; the user token is revoked; an installation bound elsewhere is refused (globally unique) | `github.security` (installation setup), `api github` (forged id, other session's state), E2E flows 1–2 |
| Repository spoofing | Repositories keyed by immutable id within the delivering installation; a repository event naming another installation's repository is ignored; removed repositories are never remapped | `github.security` (repositories outside the installation, lifecycle) |
| Tenant isolation | Tenant only from the stored binding; jobs reject payloads naming another organization; composite FKs on every GitHub table reject cross-organization rows; services never read or change another organization's GitHub data | `github.security` (tenant isolation, composite FKs, tenant guard), `github jobs` |
| IDOR and PR leakage | Project tab needs `github.view` on the project (outsiders `403`/`404` without existence leaks); the ticket panel shows only pull requests of repositories mapped to the ticket's project and `visible:false` without `github.view`; link search and linking are scoped the same way | `api github` (field, pm, gm, tier), `github.security` (project tab, ticket panel), E2E flows 11–13 |
| Jira-link cross-tenant / cross-project | Inference only confirms cached issues of Jira projects mapped to the same project; manual links accept only such cached issues; dismissed links are never recreated; keys never create issues | `github.security` (Jira keys, manual links) |
| Privileged mapping and administration | Every admin route needs ORG-wide `integration.manage` with fresh MFA (`401 MFA_REQUIRED`), CSRF on unsafe methods; gm/pm/employee `403`; audited | `api github` (administration gates), E2E flow 12 |
| Rate-limit exhaustion | Per-user `github` bucket on routes that call GitHub or queue work; installation-wide pause on primary/secondary limits; bounded pages and retries. **Fixed**: every check, status and review delivery triggered its own three-call refresh, so a backlog after a pause or outage multiplied API calls exactly when the limit was tight; refreshes already covered by a newer fetch are now coalesced | `github.security` (coalesces a backlog…; pauses on rate limits), `github-adapter` (retry budget) |
| Stale overwrite | `gh_updated_at` guard for pull-request fields; head-SHA plus fetch-start guard for review/check summaries | `github.security` (older snapshot) |
| Transaction connection misuse | **Fixed**: project tab and ticket panel services issued parallel queries (`Promise.all`) on the request's single transaction connection, which `pg` deprecates and which can interleave results; they are now sequential | `api github` (database access: no concurrent-query warning across all GitHub routes) |
| Unsafe raw SQL | Cross-tenant scans in `platform/db/sql/github-scan.ts` are tagged and parameterized, validate GitHub ids, and only identify organizations or rows; the purge function has a fixed search path and is `EXECUTE`-only for the runtime role | code review, `raw-sql-lint-policy`, `github.security` (retention) |
| Browser-visible secrets | The browser sees the install URL (App slug and state) and redirect outcomes only; setup and callback responses are `no-store`; OpenAPI contains no secret fields | `api github` (status without secrets, redirects), OpenAPI review |
| Test-only endpoints | `FakeGithub` lives in `@company-ops/core/testing`, imported only by tests; its `/__fake/*` routes are not reachable through the API | `api github` (test-only surface) |
| Retention | No policy → nothing purged; dry run before saving; only processed deliveries and sync failures; audit history and business links untouchable | `github.security` (retention), `api github` (retention policies, dry run) |

Residual risks (accepted): the integration has **not been exercised against GitHub.com** (DEPLOYMENT §6 checklist before production); the Phase 3 ticket-creation path still triggers one `pg` concurrent-query deprecation inside Prisma's own query handling (not GitHub code; tracked for the Phase 9 dependency review); coalescing assumes API and worker clocks within 5 s (reconciliation corrects larger skew); the purge function can be called by the runtime role for any organization, but only ever applies that organization's own policy (since Phase 6 the application caller takes the organization only from the trusted tenant context, with a cross-tenant negative test in `github.security`); cached pull-request titles and branch names are visible to every `github.view` holder of the mapped project, regardless of their own GitHub access.

## 15f. Phase 6 internal security review (2026-10-04)

Scope: request types and workflow administration, the form DSL and its renderer, workflow versions and steps, the engine, submission, approvals and the inbox, delegation, reassignment, fulfillment, cancellation, request attachments, effects (the Phase 7 boundary), notifications, live hints and SLA reminders. Decisions: ADR-0021. Items marked **fixed** were found during Phase 6 testing or this review and have regression tests. Evidence names refer to `packages/core/test/requests/engine.test.ts` (`engine`), `packages/core/test/requests/requests.security.int.test.ts` (`requests.security`), `apps/api/test/requests.int.test.ts` (`api requests`), `apps/worker/test/requests-worker.int.test.ts` (`requests worker`) and `apps/e2e/tests/11-requests.spec.ts` (E2E scenarios 1–20).

| Area | Result | Evidence |
|---|---|---|
| Tenant isolation | Organization only from the trusted context; composite FKs on every request table reject cross-organization rows; foreign ids for types, requests, approvals, delegations, members, roles and attachments are `404` | `requests.security` (tenant isolation, both tests), `api requests` (tenant isolation over HTTP) |
| IDOR on requests and history | Visibility = requester, assigned approvers and their active delegates, or `request.view` scope; drafts private; invisible requests `404` (detail, history, attachments, decisions) | `requests.security` (refuses approvals by members who are not assigned), E2E 14 |
| Self-approval and approver choice | The engine never resolves the requester, including through delegation; no rule takes an approver from a requester-filled field; the requester deciding is `403` | `engine` (never resolves the requester), `requests.security` (delegation not transitive…), `api requests`, E2E 14 |
| Auto-approval | Publish requires an unconditional first approval step; an unresolvable approver refuses the submission and stores nothing; a later empty step waits for an administrator | `engine` (reports no approver), `requests.security` (never auto-approves) |
| Approver tampering after submission | Approvers frozen at activation; database triggers keep decided approvals, the pinned version, form data and route immutable for every role; requests and approvals are never deleted | `requests.security` (freezes the approvers; append-only history) |
| Published workflow mutation | Service refuses (`409 INVALID_TRANSITION`) and database triggers reject changes to published/retired versions and their steps; a new version never alters requests on the old one | `requests.security` (workflow versions), `api requests` (administration), E2E 15–16 |
| Configuration injection | Bounded declarative DSL; no expressions, regular expressions, templates or SQL; strict Zod meta-schema with size caps; conditions type-checked against fields; rendered values are text only | `engine` (form schema meta-validation), `requests.security` (rejects unsafe or invalid workflows) |
| Form data validation | Server-side against the pinned schema: unknown keys, hidden-field values, types, ranges, sizes and member/project references (tenant-scoped) | `engine` (form data validation), `requests.security` (validates form data…), `api requests` (rejects hidden, unknown and invalid values) |
| Double decisions and races | Decisions lock the request row with a conditional update; exactly one of concurrent ANY-ONE approvers wins; ALL completes once; identical retries are idempotent, conflicting ones `409 REQUEST_ALREADY_DECIDED` | `requests.security` (concurrent ANY-ONE; ALL under concurrency; repeated decision), `api requests` |
| Duplicate submission | `Idempotency-Key` unique per requester; replay returns the same request, different content `409`. **Fixed**: replays were compared on raw content, so a retry whose blank values had been normalized away was refused; replays now compare normalized content for every status | `requests.security` (replays an idempotent submission), `api requests` (submits once per idempotency key) |
| Delegation abuse | Period ≤ 90 days, no self (CHECK), no overlap, no reverse cycle, not transitive, delegate must be an eligible approver, foreign members refused, revocable; creation and revocation audited; decisions record the acting member and delegation | `requests.security` (delegation, three tests), E2E 13 |
| Privilege escalation through administration | `request.admin` (ORG scope) for types, versions, reassignment and admin cancellation. **Fixed**: `request.admin` decides who approves what but was not privileged; it now needs fresh MFA (`401 MFA_REQUIRED`). Reassignment never targets the requester or a member already on the step | `api requests` (needs fresh MFA), `requests.security` (limits administration…; reassign), `packages/shared/test/permissions.test.ts` |
| Separation of duties in fulfillment | Only `request.fulfill` holders, never the requester | `requests.security` (fulfils approved requests by fulfillers only) |
| Attachments | Existing storage foundation (owner `REQUEST`, MIME/size allow-list, pre-signed URLs); upload only while allowed by the version policy; listing and download follow request visibility | `requests.security` (attachments), E2E 17 |
| Phase 7 boundary | Effects written only by the engine on final approval in the same transaction (unique per request and kind), revoked only by administrator cancellation; the worker acknowledges only inside the event's organization and creates no attendance data | `requests.security` (effects), `requests worker` (acknowledges a recorded effect only inside the event organization) |
| Notifications and email | Outbox with deduplicated keys; recipients re-checked at send time (inactive → `skipped_inactive`); emails contain the request key, type and link only, never form data or comments; reminders once per assignment; live hints only to people involved | `requests worker` (all four tests), E2E 20 |
| CSRF, rate limits, errors | Unsafe methods need the CSRF token; routes use the general per-user limits (no external calls); stable error codes; audit for configuration, delegation, decisions, reassignment and admin cancellation | `api requests`, `requests.security` (audits configuration changes) |
| Retention purge tenant source | **Fixed** (Phase 5 carry-forward): the purge caller accepted an organization argument; it now uses the trusted tenant context only | `github.security` (retention cross-tenant negative test) |

Residual risks (accepted): requests on behalf of others and free-form comments are deferred; delegation overlap is enforced in the service under a per-organization lock rather than by an exclusion constraint; role steps resolve at most 25 approvers (ALL steps above that are refused at activation and need reassignment); SLA reminders depend on the worker sweep interval (default 5 minutes). Attendance effects are materialized since Phase 7 (§15g).

## 15g. Phase 7 internal security review (2026-10-04)

Scope: the attendance policy, work-location eligibility, check-in/out, shifts and assignments, records and events, reviews, team and HR views, the employee correction request type, administrator corrections, effect materialization, the missing-checkout sweep, export, coordinate retention, notifications and the web screens. Decisions: ADR-0022. Items marked **hardened** were added during this review and have regression tests. Evidence names refer to `packages/core/test/attendance/engine.test.ts` (`engine`), `packages/core/test/attendance/attendance.security.int.test.ts` (`attendance.security`), `apps/api/test/attendance.int.test.ts` (`api attendance`), `apps/worker/test/attendance-worker.int.test.ts` (`attendance worker`), `packages/shared/test/logging.test.ts` (`logging`) and `apps/e2e/tests/12-attendance.spec.ts` (E2E flows 1–22).

| Area | Result | Evidence |
|---|---|---|
| Client organization, employee and location ids | Tenant from the session only; the check-in body is strict (status, latitude, longitude, accuracy), so `organizationId`, `profileId`, `workLocationId` are `400`; locations are chosen by the server | `api attendance` (requires a UUID Idempotency-Key and a strict body…) |
| Client distance and timestamp | Server-side haversine and server clock; client `distanceMeters` / `recordedAt` are `400` (**hardened**: explicit regression cases added) | `api attendance` (strict body), `engine` (geofence and time), `attendance.security` (records server-decided evidence…) |
| Forged and ineligible locations | Inactive locations, other organizations' locations and sites of projects the employee does not actively belong to never match; nothing is stored on refusal | `attendance.security` (refuses positions outside…; never matches inactive or foreign locations; accepts an active project member at the project site), E2E 6 |
| Low accuracy | Never `INSIDE`; policy decides between review and refusal; reviews by `attendance.admin` or `attendance.team` in scope, never by the employee, once only | `attendance.security` (flags low accuracy…; applies the policy…), E2E 7 |
| IDOR and manager scope | Records, details, reviews, team day and export filter in SQL by the policy scope; anything outside is `404`, without the permission `403`; reach is resolved per request | `attendance.security` (shows records to the employee, their team lead and HR only…), `api attendance` (shows records to the team lead and HR, 404 to others…), E2E 14–15 |
| Correction privilege escalation | Employees correct only their own records, through the Phase 6 engine (approver = direct manager, never the requester); direct corrections need `attendance.admin` (ORG), fresh MFA and a reason, never one's own record, optimistic version; a foreign profile id is `404` (**hardened**: regression added) | `attendance.security` (corrections, both tests), `api attendance` (needs fresh MFA…; submits an employee correction as a request…), E2E 16–19 |
| Changing evidence | Events are append-only for every role (triggers block `UPDATE`/`DELETE`/`TRUNCATE`, even for the owner); the trusted adjustment row is immutable apart from one-time apply/revert markers; corrections add `ADJUSTED` events and keep the originals | `attendance.security` (keeps evidence append-only…; runs an employee correction…), E2E 19 |
| Effect forgery | Effects are written only by the Phase 6 engine; the consumer loads the effect by id, request and the job's organization, requires the matching status, and binds corrections to the requester's own adjustment row; forged pairs, other organizations and revocations that never happened are rejected without writes (**hardened**: regression added) | `attendance.security` (materializes approved leave…; runs an employee correction…) |
| Duplicate check-in/out and races | Per-organization/profile advisory lock plus one record per profile and day; `Idempotency-Key` bound to user and action; concurrent check-ins yield one success; concurrent replays one event | `attendance.security` (serializes concurrent check-ins…), `api attendance` (creates once…), E2E 4 |
| Missing checkout and future days | Bounded batch per pass, deterministic keys, never invents a check-out, one notification; future and current days are never absent | `attendance.security` (missing checkout; never shows future days as absent), `attendance worker` |
| Retention cross-tenant access | Purge runs per organization from the trusted context; another organization's policy never clears this one's coordinates; coordinates cleared only through the `SECURITY DEFINER` function; evidence and audit history kept (**hardened**: cross-tenant regression added) | `attendance.security` (clears aged coordinates under an explicit policy only…) |
| Coordinate leakage | Not in responses, errors (distance and location name only), exports, notifications or the detail UI; logs carry no bodies and the redaction list covers coordinate keys (**hardened**) | `attendance.security` (refuses positions outside…; flags low accuracy…; exports…), `api attendance`, `logging`, E2E 13 |
| Excessive collection | One position per explicit tap; none for remote work and missions; no tracking; IP and user agent to `attendance.admin` only | `attendance.security` (records approved remote work…; shows records…device details to HR only), E2E 2, 9 |
| Rate limits | Per-user attendance bucket; replays do not store anything and remain safe after a `429` | `api attendance` (limits check-ins per user without breaking a burst of retries) |
| Database integrity | Composite tenant foreign keys on every attendance table; overlapping assignments rejected by an exclusion constraint | `attendance.security` (keeps evidence append-only and organizations apart…; handles an overnight shift…) |
| Configuration audit | Policy (`org.settings.manage` + MFA), shifts, assignments, reviews, corrections, exports and retention are audited | `attendance.security` (applies the policy…; handles an overnight shift… (assignments); flags low accuracy… (review); lets HR correct directly…; exports…; clears aged coordinates…) |

Residual risks (accepted): geolocation is evidence, not proof (spoofing tools exist; the UI says so); the missing-checkout sweep handles 500 open records per organization and pass (default every 15 minutes), so a backlog drains over several passes; effect materialization covers at most 62 days per effect (later days derive from the effect when displayed); the employee correction window is 31 days and the administrator window 366 days; Phase 7 has not been load-tested beyond the integration and E2E suites.

## 15h. Phase 8 internal security review (2026-10-04)

Scope: the role dashboards, Needs Attention, trends, the Redis dashboard cache and its invalidation, global search, the setup checklist, notification preferences (including the email worker re-check) and the web screens. Decisions: ADR-0023. The items marked **fixed** were found during Phase 8 and have regression tests; every other control is covered by the tests named. Evidence names refer to `packages/core/test/dashboard/dashboard-engine.test.ts` (`engine`), `packages/core/test/dashboard/dashboard.security.int.test.ts` (`dashboard.security`), `apps/api/test/dashboard.int.test.ts` (`api dashboard`), `apps/worker/test/notification-job.test.ts`, `jira-jobs.test.ts`, `project-jobs.test.ts` (`worker`) and `apps/e2e/tests/13-dashboard.spec.ts` (E2E 1–22).

| Area | Result | Evidence |
|---|---|---|
| Dashboard authorization | Each route re-checks its permission; every number comes from the caller's server-resolved list scope; hidden cards are UX only | `dashboard.security` (role scopes), `api dashboard` (401 / 403 on every route), E2E 13 |
| Count / list consistency | Counts use the list services' `where` builders with the filter object the link encodes; for every role, each linked number equals the length of the list its link opens (paged to the end). **Fixed:** list screens read the link's filters from `window.location` during their first render, which after a client-side navigation still held the previous URL, so a tile opened an unfiltered list; they now read the query through the router (`WithLinkParams`, remounting when it changes) and the attendance tab through `useLocationHash` | `dashboard.security` (count = list length), E2E 1, 6–9 (tiles clicked, list rows counted) |
| Per-person metrics | None: support has "assigned to me", Jira/GitHub signals are per project, attendance is counts only (no locations) | code review, `dashboard.security` |
| Cache cross-scope / cross-tenant reuse | Keys carry the organization, a hash of the exact scopes read (member id for personal data) and the domain versions; members with different scopes never share an entry; the permission check runs before the cache is read | `dashboard.security` (cache security: per-member keys, tenant prefixes, permission before cache, version bump) |
| Cache failure | Errors and hanging Redis calls fall back to the source queries; the cache is never authoritative | `dashboard.security` (failing and hanging stores) |
| Search injection and wildcards | Prisma parameter binding only; `%`, `_` and `\` are escaped before `ILIKE`, so `%%` or `__` match nothing instead of everything | `engine` (LIKE escaping), `dashboard.security` (LIKE wildcards) |
| Search authorization | Each entity is filtered in SQL by its list scope (projects `project.view`, employees `employee.view`, tickets `support.view` incl. own, requests own + `request.view`, Jira issues `jira.view` projects); other organizations never match | `dashboard.security` (search security: scope, tenant both ways), E2E 14–17 |
| Contact data in search | Email is matched only for callers with `employee.view_contact` at ORG scope, so a directory search cannot probe for addresses | `dashboard.security` (email only with view_contact) |
| Organization-wide request scope | `request.view` at ORG returned no requests because Prisma matches nothing for an empty object inside `OR` (Phase 6 defect, **fixed**: organization scope no longer builds an `OR` branch) | `dashboard.security` (HR, GM and admin find a request by key; `requests.list(view: 'all')`) |
| Search bounds and abuse | 2–100 characters, ≤ 10 per type, cursors bound to the query and type, per-user rate limit (refused queries count too); search text is never logged (query strings are stripped from request logs) | `dashboard.security` (bounds), `api dashboard` (rate limit 429 with Retry-After; other routes and users unaffected) |
| Setup checklist | `org.settings.manage` at ORG only; derived from state, nothing writable | `dashboard.security` (setup checklist), `api dashboard`, E2E 13, 18 |
| Preferences | A member reads and changes only their own rows (no member id in the API); strict body, CSRF on `PUT`, duplicates refused; ACCESS, in-app INTEGRATIONS and CRITICAL notifications cannot be muted; changes audited | `dashboard.security` (preferences), `api dashboard` (CSRF, locked items, isolation), E2E 19 |
| Muted notification delivery | Muted in-app notices are stored as read (history intact); muted email creates no delivery, and the worker re-checks the preference and marks queued deliveries SKIPPED | `dashboard.security` (worker re-check: `skipped_preference`) |
| Invalidation jobs | Payloads are strict (organization and known domains only) and processed in the event's organization; malformed payloads fail permanently without writes | `worker` (dashboard invalidation job) |
| Realtime | SSE stays a hint with ids only; dashboards refetch through the authorized API | Phase 3 realtime tests, code review |

Residual risks (accepted): a delegation or role change that does not emit an event is reflected in cached numbers after at most 60 s (the scope hash changes immediately for grants that change the caller's scope; the TTL covers the rest); missing daily reports are counted for at most 200 projects per request; Needs Attention is capped at 50 items with a "more exist" flag; search ranks deterministically but not by relevance scoring; Phase 8 has not been load-tested beyond the integration and E2E suites.

## 15i. Phase 9 internal security review (2026-10-04)

Scope: production hardening.
- **Configuration:** production configuration, secret files, images, Compose, the TLS proxy and the production Keycloak realm.
- **Data and access:** database roles, log redaction, custom roles, dependency-failure behaviour, backups and restore.
- **Process:** the release pipeline.

Runbooks: `docs/runbooks/`. Items marked **fixed** were found during Phase 9 and have regression tests or a rehearsal.

| Area | Result | Evidence |
|---|---|---|
| Secret output | The bootstrap CLI writes the invitation link to a `0600` file (`--invitation-file`) instead of stdout (**fixed**). The dev seed and maintenance CLIs print no secrets | `packages/core/test/organizations/invitation-output.test.ts`, code review |
| Log redaction | One central redactor (`packages/shared/src/logging.ts`) for API, worker, CLIs and BullMQ error logging (**fixed**: BullMQ job errors were logged unredacted). It covers headers, secret-like keys at any depth, and free-text bearer tokens, JWTs, GitHub tokens, private keys, URL credentials, sensitive URL parameters, session cookies and coordinates | `packages/shared/test/logging.test.ts`, `apps/api/test/logging.test.ts` (real HTTP request through the logger) |
| Secrets in configuration | Every secret accepts `NAME_FILE`; production Compose passes only `_FILE` paths (Docker secrets, `0444` in a `0700` root directory). Giving both forms of one secret is refused at startup. Production refuses development defaults, placeholder values, `http://` public URLs, Swagger and short keys | `packages/config/test/*` (env and production-artifacts tests), `scripts/ops/init-secrets.sh` (rehearsed) |
| Encryption key rotation | `APP_ENCRYPTION_KEYS_PREVIOUS` (at most 5) decrypts old envelopes, and the current key encrypts. Rotating keys does not end sessions | `rehearse.ts rotate` (old DB and Redis passwords refused, session kept), `docs/runbooks/secrets.md` |
| Transport and headers | TLS 1.2/1.3 only at the proxy, HTTP redirects to HTTPS, HSTS (no preload), `nosniff`, `frame-ancestors 'none'` (API) and a nonce CSP (web). Keycloak admin and master realm paths are not routed publicly | `apps/api/test/http-security.int.test.ts`, `apps/web/test/proxy.test.ts`, `scripts/release/smoke.ts` (13 checks against the rehearsal stack) |
| CSP `style-src 'unsafe-inline'` | **Accepted risk**: Radix UI and Next.js set inline `style` attributes, which nonces cannot cover. Scripts stay nonce and `strict-dynamic` only, so injected style cannot run code. The risk left is CSS-based UI redressing, which React escaping and the sanitizing markdown renderer already prevent at the source | code review |
| Custom roles | `role.manage` (ORG, privileged, MFA). ORG_ADMIN is immutable. Only ORG_ADMIN holders create or change administrator-equivalent roles, and nobody edits a role they hold. System roles keep their name and cannot be deleted. Roles in use cannot be deleted. Grants are validated against the catalog. Changes bump `authz_version` of holders and are audited. All of this runs under the organization's admin-change lock | `packages/core/test/access/role-admin.security.int.test.ts`, `apps/e2e/tests/14-roles.spec.ts` (UI lifecycle, holder gains and loses access, API 403s) |
| SUPER_ADMIN | Inert in V1: no code reads or writes `users.platform_role`, there are no platform endpoints, and the bootstrap CLI does not set it. ADR-0010 remains the design for a later phase | code search, `packages/shared/src/roles.ts` |
| Raw SQL | `$queryRawUnsafe`/`$executeRawUnsafe` banned by lint and refused at runtime. Tagged raw SQL is allowed only in `platform/db/sql/` with explicit `organization_id` binding | ESLint config, tenant-guard security tests |
| Dependency failure | PostgreSQL or Redis outage: readiness becomes `503`, requests fail fast with `503 DEPENDENCY_UNAVAILABLE` (no hanging, no stack traces), and the service recovers by itself. Proxy-generated `429/502/503/504` use the API JSON envelope for API callers and a static page for navigations | `apps/api/test/dependency-outage.http.test.ts`, `health.http.test.ts`, Redis and PostgreSQL outage rehearsals (`docs/runbooks/redis.md`) |
| Uploads without malware scanning | **Accepted risk** (decision): V1 ships the `AttachmentScanner` port with the no-op adapter, and files are stored as `NOT_SCANNED`. Mitigations: authenticated members only; a short type allow-list (no HTML, SVG or executables) checked by magic bytes; size caps; private bucket. Downloads come from the separate storage origin as `attachment` with the sniffed type, so no file runs in the application origin. A ClamAV adapter would need an extra service of about 1 GB RAM and signature updates. It can be added behind the port without schema changes. Operators should keep endpoint protection on client machines | `packages/core/src/platform/storage/storage-port.ts`, attachment tests (§6) |
| Identity provider | Production realm: `sslRequired: all`, 12-character password policy with history, brute-force lockout, required TOTP for admins via LoA step-up. User and admin events are kept for 30 days (**fixed**: events were off). No users are imported | `packages/config/test/production-artifacts.test.ts`, throwaway Keycloak 26.8 import check, `docs/runbooks/keycloak.md` |
| Incident response | Mass session revocation (`ops:sess*` flush) rehearsed: the old cookie gets `401`. Secret rotation procedures rehearsed | `docs/runbooks/secrets.md` |
| Backups | `ops_backup` is read-only. Dumps are verified by a test restore. Restore into production was rehearsed (row counts identical, smoke 13/13) | `docs/runbooks/backup-restore.md` |
| Supply chain | Trivy gate, SBOMs, report-only scan of third-party images, `pnpm audit` with expiring exceptions, gitleaks | §13 |

**ASVS 5.0 Level 2, chapter view** (internal review against the published requirements; not a third-party assessment):

| Chapter | Status |
|---|---|
| V1 Encoding and sanitization | Met: React escaping, sanitizing markdown, parameterized SQL only, no `dangerouslySetInnerHTML` |
| V2 Validation and business logic | Met: strict Zod schemas, server-side state machines, idempotency keys, rate limits |
| V3 Web frontend security | Met, with the `style-src 'unsafe-inline'` accepted risk above |
| V4 API and web service | Met: CSRF (origin + synchronizer token), CORS allow-list, JSON-only bodies with size caps |
| V5 File handling | Met except malware scanning (accepted risk above) |
| V6 Authentication / V7 Session management | Met by Keycloak (OIDC + PKCE, TOTP, brute-force) and the BFF session (rotation, idle/absolute timeouts, back-channel logout) |
| V8 Authorization | Met: deny-by-default guard, scoped policies, tenant guard, 404 for foreign ids, MFA for privileged permissions |
| V9 Self-contained tokens | Met: ID and logout tokens validated (signature, `iss`, `aud`, `exp`, `nonce`/`jti`); no tokens in the browser |
| V10 OAuth and OIDC | Met for the Keycloak client. Jira OAuth and the GitHub App are implemented, but live validation is a **pre-production external blocker** (no real tenant available) |
| V11 Cryptography | Met: AES-256-GCM with AAD and key ids, CSPRNG ids, SHA-256 token hashes |
| V12 Secure communication | Met at the proxy (TLS 1.2+); the internal Docker network is plaintext by design (single host) |
| V13 Configuration | Met: secret files, production validation, no debug or Swagger in production, minimal images |
| V14 Data protection | Met: no PII in metrics, redacted logs, retention policies, coordinates restricted |
| V15 Secure coding and architecture | Met: pinned dependencies, audit gate, SBOMs |
| V16 Security logging and error handling | Met: audit log append-only, error envelope without internals, request ids |
| V17 WebRTC | Not applicable |

Residual risks (accepted):
- **Accepted risks named above:** missing malware scanning and inline styles.
- **Single host:** single PostgreSQL and Redis instances (`docs/runbooks/redis.md`; recovery procedures rehearsed).
- **Keycloak audit:** Keycloak admin events do not include the representation (`adminEventsDetailsEnabled: false`), which avoids storing user data in events.
- **Monitoring:** there is no bundled monitoring stack. The signals and example alert rules ship, and the operator connects them (`docs/runbooks/observability.md`).
- **External integrations:** live Jira Cloud and GitHub validation remains a pre-production external blocker. Both integrations stay disabled until their configuration is supplied, and the production overlays are opt-in.

## 15j. Phase 10 internal security review (2026-10-05)

Scope: tenders, the Corporate Document Vault, contracts and their sub-records, commercial dashboards, search, reports, notifications and the commercial monitor (ADR-0026, §2.6). Items marked **fixed** were found during Phase 10 and have regression tests.

| Area | Result | Evidence |
|---|---|---|
| Tenant isolation | Every commercial table carries `organization_id` with composite foreign keys; every service query goes through the tenant guard; foreign ids return `404` on the API, sub-routes and the UI; search groups return nothing for foreign records | `commercial.security.int.test.ts` (reads and writes of another organization's tenders), `apps/api/test/commercial.int.test.ts`, `15-commercial.spec.ts` (35–36) |
| Contextual access | FULL vs INVOLVED vs `404` decided in one place (`commercial-access.ts`) and reused by detail, lists, search, dashboards, Needs Attention, reports and the project Commercial tab | API test "involved access without financial values, and nobody else", E2E 33 |
| Financial confidentiality | Money fields absent without the financial permission in scope, in every surface including CSV and dashboards | API tests (amendment value deltas, exports), E2E 33 and 37 |
| Restricted documents | Classified documents hidden without a count or any other trace (lists, pagination, search, dashboard, Needs Attention, requirement links, version references, timeline, write paths); both attachment endpoints `404` for callers without the permission. **Fixed in remediation:** the tender/contract document lists returned a `restrictedCount`, requirement links to hidden documents were listed with a null document, submission evidence titles and raw version ids of hidden documents were returned, and hidden documents' timeline events were listed | API test "attaches tender documents with classification", `document-confidentiality` (A–D, cache re-key on grant and role edit), `commercial.security` (submission evidence), E2E 34 |
| Commercial search | Guarantee references and issuers, tender/contract keys, titles and customer names match only within the record's own visibility; no prefix or exact reference reveals an out-of-scope or foreign guarantee; snippets carry no money | `commercial-search` (authorized, project scope, owner, field, cross-tenant, prefixes, amounts), E2E 29–30 |
| Readiness projection | Stored counters equal the counters recomputed from requirement rows after create, status change, mandatory toggle, NOT_APPLICABLE, delete, rejected and rolled-back changes and concurrent updates; detail, list and the readiness filter (dashboard) agree; a corrupted projection rebuilds deterministically | `readiness-consistency`, E2E 1–14 (step 6) |
| Corporate vault links | **Fixed**: the document detail returned no linked requirements for any caller. Links are now listed to callers who can read the linking tender (or own/review the requirement), and to nobody else | `commercial.security.int.test.ts` › corporate vault |
| Privilege escalation | Sensitive commercial permissions can be granted (role grant, new role, added role grant) only by ORG_ADMIN holders or holders of the permission at ORG scope | `role-admin.security.int.test.ts` › escalation rules |
| Database least privilege | `ops_app` has no UPDATE/DELETE on append-only commercial history and no DELETE on records that are archived instead (**fixed**: DELETE on `tender_requirements` was also revoked although requirements without document history are removable, so the removal would have failed in production) | `production-roles.int.test.ts` (commercial privileges) |
| Four-eyes | Amendment approval refuses the author; FINAL tender review needs `tender.approve` and an assigned review | `commercial.security.int.test.ts` › amendments, API test "four eyes" |
| Idempotency and concurrency | Submission, award, loss, create-contract and renewal decisions require `Idempotency-Key` and replay once; aggregate locks plus version checks on every mutation | core and API integration tests |
| Input validation | Strict Zod schemas with length caps; decimal strings for money; unknown fields refused | API test "refuses unknown fields" |
| Export safety | Formula-injection guard on every cell, bounded rows, audited exports | API test "exports formula-safe CSV" |
| Rate limits | Status-changing commercial operations use the `sensitive` bucket (§2.6) | `@PrincipalRateLimit('sensitive')` on the controllers |
| Background job | Monitor runs per organization under a system tenant context, idempotent reminders (unique reminder keys), no automatic completion or renewal | `commercial.security.int.test.ts` › commercial monitor, `commercial-worker.int.test.ts` |
| Audit | Lifecycle, approvals, money changes, classification changes, settings and exports audited (append-only audit log unchanged); business timelines are separate from audit | code review, integration tests |

No new accepted risks. Residual risks from §15i are unchanged.

## 15. Security review checklist per feature (Definition of Done addendum)

- [ ] Permission key(s) in catalog and mapped in the §2.5 baseline
- [ ] Privileged? Added to `PRIVILEGED_PERMISSIONS` and §2.3
- [ ] Resource policy enforces scope; list filter uses the same policy
- [ ] §4.4 tenancy checklist rows applicable to the feature satisfied
- [ ] §4.5 negative tests added (read, list, create-relationship, update-relationship)
- [ ] Zod schema `.strict()` with length caps
- [ ] Audit events for sensitive mutations
- [ ] No secrets/PII in logs
- [ ] Rate limit appropriate
- [ ] Errors mapped to stable codes
