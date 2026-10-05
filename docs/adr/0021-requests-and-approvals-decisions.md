# ADR-0021: Requests and approvals decisions (Phase 6)

Date: 2026-10-04 · Status: Accepted

## Context
Phase 6 delivers internal requests and approvals (ROADMAP P6-1…P6-9): organization-configurable request types, a bounded form DSL with a dynamic renderer, versioned workflows with approver rules and conditions, a pure workflow engine, submission that pins the workflow version, "My requests", request detail with history, the **Needs My Approval** inbox, delegation, generic fulfillment, dev-seed request types, the approved-request effect boundary for Phase 7 attendance, and deduplicated approval SLA reminders. `PRD.md` §7.3, `DATA_MODEL.md` §6, `SECURITY.md` §2.4–2.5 and `ARCHITECTURE.md` describe the Phase 0 logical design. Decisions follow the priority order repository documents → earlier ADRs → master specification → existing implementation → safest production practice. Where this ADR differs from the Phase 0 logical model, this ADR applies; the physical schema is in `DATA_MODEL.md` "Phase 6 — Requests".

## Decision

### One generic engine
- Leave, work from home, equipment, access, purchase, missions and every other request kind are **configurations** of one engine: there is no per-type table, controller, service or state machine. Seeded types (P6-7) use the same administration model as organization-created types.
- **Request type** (`request_types`, not versioned): key, localized name/description (`{ en, ar? }`), category, icon (allow-listed), active flag and requester eligibility (`request_type_roles`: no rows = every member holding `request.create`). It has exactly one **workflow definition** (`workflow_definitions`, 1:1), which points at the version used for new submissions.
- **Workflow version** (`workflow_versions`) carries everything that decides how a request is filled in and processed: the form schema, the attachment policy, declarative effects, notification behavior and the ordered steps (`workflow_steps`). Versioning them together means a published combination can never change underneath a request.

### Versioning and immutability
- Per definition there is at most **one DRAFT** and **one PUBLISHED** version (partial unique indexes); older published versions become **RETIRED**. Only a DRAFT can be edited (whole-content replace, `revision`-checked) or discarded. "Edit" on a published workflow creates a new DRAFT copied from it; publishing it retires the previous version and moves the definition's pointer, in one transaction.
- Database protections (not only application logic): a trigger rejects any change to a PUBLISHED/RETIRED version except PUBLISHED → RETIRED, rejects deleting non-draft versions, and rejects inserting, changing or deleting steps of a non-draft version. A second trigger rejects changing `workflow_version_id`, `form_data`, `request_type_id`, `requester_member_id` or `number` of a request once it has left DRAFT.
- Publishing validates the whole configuration: at least one approval step; the first step is an **unconditional approval step** (so every submitted request needs at least one human approval: the engine never approves a request on its own); fulfillment steps come after all approval steps; conditions and effects reference existing fields of compatible types; specific-member approvers are active members; referenced roles exist.

### Forms (P6-1)
- Flat field list, at most 40 fields, keys `^[a-z][a-zA-Z0-9_]{0,39}$`, unique. Types: `text`, `textarea`, `number`, `money` (ISO currency, two decimals), `date`, `date_range`, `time`, `boolean`, `select`, `multiselect`, `member`, `project`, `info` (display only). Per type: required, min/max, length limits, allowed options (≤ 50), localized label/help. Conditional visibility (`visibleWhen`) uses the condition model below. Schema ≤ 64 KiB; submitted data ≤ 32 KiB.
- Nothing in configuration is executed: no JavaScript, expressions, regular expressions, SQL or templates. The meta-schema (Zod, `packages/validation`) rejects unknown properties, duplicate keys, invalid references and pathological sizes.
- Data validation (server, `packages/core` engine): unknown keys and values for hidden fields are rejected; required visible fields must be present on submission (drafts are validated leniently: types and limits only); `member` values must be active members of the organization and `project` values non-archived projects the requester can view (tenant-scoped lookups).
- Attachments are a **version-level policy** (`NONE | OPTIONAL | REQUIRED`, max files) instead of a form field: files are uploaded to the request (draft) through the existing attachment foundation (owner type `REQUEST`), and submission checks the policy.

### Conditions
- Deliberately small and declarative: one group `{ match: all | any, rules: [...] }` of at most 10 rules `{ field, op, value? }` with `eq, neq, gt, gte, lt, lte, in, notIn, isSet, isNotSet`. No nesting, so the contract stays flat (no recursive OpenAPI schema) and the builder stays simple; the purchase-threshold and leave-type routes need nothing more. Rules are type-checked against the referenced field (the same checker runs in the API at publish time and in the web builder). Only form fields are addressable. A missing (hidden or empty) value makes every comparison false except `isNotSet` (and `neq` / `notIn`, which are true). Evaluation is pure and deterministic.

### Workflow engine (P6-3)
- `packages/core/src/modules/requests/engine/` is pure (no I/O): form validation, condition evaluation, route planning (which steps apply, in order), approver selection from a pre-loaded organization snapshot, step decisions (ANY_ONE / ALL, rejection) and the next request state. Persistence loads the snapshot and applies the result inside one transaction.
- Conditions are evaluated **once at submission** over the immutable form data; the applicable route (step orders) is stored on the request (`route`). Later configuration changes cannot alter it.

### Approver resolution (security-sensitive)
- Rules: `DIRECT_MANAGER`, `DEPARTMENT_MANAGER` (walking up the department tree past the requester), `TEAM_LEAD` (leads of the requester's non-archived teams), `PROJECT_MANAGER` / `TECHNICAL_MANAGER` (of the project chosen in a `project` field), `ROLE` (holders of an organization role, composite FK) and `MEMBER` (a specific member, composite FK). Rules are typed columns, not free JSON. **No rule takes an approver from a requester-filled member field**, so a requester can never choose their own approver.
- Eligible approvers: ACTIVE membership with a sign-in identity, employment ACTIVE or ON_LEAVE, holding `request.approve`, and **never the requester** (no self-approval, including through delegation). A step resolves at most 25 approvers (deterministic order); an ALL step that would need more is treated as unresolved.
- **Model: resolve at step activation and freeze** (DATA_MODEL §6). Each activated step writes one `request_approvals` row per resolved approver; rows are never rewritten because a manager, department, team or role changes later. Submission additionally **preflights** every applicable step against the current structure and refuses the submission (`409 REQUEST_APPROVER_UNRESOLVED`, nothing created) if any step has no eligible approver.
- If a later step resolves to nobody when it activates (people left in between), the request stays `PENDING_APPROVAL` on that step with no approvers, members holding `request.admin` are notified, and an administrator **reassigns** it. Inactive assignees are handled the same way: ANY_ONE steps continue with the remaining approvers, ALL steps wait for reassignment. Reassignment (`request.admin` at organization scope) adds or replaces an assignee of the current step, is recorded in history and audited. Nothing is ever approved because an approver could not be found.

### Lifecycle
- `DRAFT → PENDING_APPROVAL → APPROVED → (IN_FULFILLMENT → COMPLETED)`, with `REJECTED` and `CANCELLED` terminal. **There is no `SUBMITTED` state** (deviation): submission activates the first step in the same transaction, so `PENDING_APPROVAL` is the submitted state. Requests without fulfillment steps end at `APPROVED`.
- Numbers come from the organization counter `REQ` (`REQ-241`) when the draft is created. Drafts are visible only to their requester and are discarded by cancelling (history and number are kept).
- A draft is bound to the type's current published version; saving a draft re-binds it to the then-current version. Submitting a draft whose version is no longer current is refused with `409 REQUEST_FORM_OUTDATED` (the UI reloads the new form). On submission the version is pinned permanently.
- The requester may cancel a DRAFT or PENDING_APPROVAL request. `request.admin` (organization scope) may also cancel APPROVED or IN_FULFILLMENT requests with a reason; that revokes any recorded effect.

### Submission and idempotency (P6-4)
- `POST /requests` creates a draft (optionally submitting it atomically) with an optional `Idempotency-Key` (UUID, unique per requester; a replay with different content is `409`). Submitting validates the type is active and the requester eligible, validates the form against the pinned schema, checks the attachment policy, preflights approvers, activates the first step, writes history and queues notifications, all in one transaction. Re-submitting an already submitted request returns its current state.

### Decisions and concurrency (P6-5)
- Holding `request.approve` grants nothing by itself: a decision needs a `PENDING` approval row assigned to the member, or to a member who delegated to them for that request type at that moment.
- Every decision runs in one transaction that first **locks the request row** with a conditional update (`status = PENDING_APPROVAL AND current_step_order = <step>`), then moves the approval row with a conditional update (`status = PENDING`). Concurrent approvers serialize on the request row; whoever loses sees the new state (`409 REQUEST_ALREADY_DECIDED`). A repeated identical decision by the same member returns the current state. So a decision is recorded once, the workflow advances once and notifications (outbox, deduplicated keys derived from the decision) are queued once.
- ANY_ONE: the first approval completes the step and the remaining assignments become `SUPERSEDED`. ALL: the step completes when every assignment is approved. Any rejection rejects the request; open assignments become `SUPERSEDED`. A rejection needs a reason. Bulk decisions are not offered (not in the roadmap).

### Delegation
- `approval_delegations`: delegator, delegate, `starts_at`/`ends_at` (at most 90 days), optional request type, reason, revocation. Created by the delegator (holding `request.approve`) or by `request.admin` (organization scope, override). Same organization (composite FKs), no self-delegation (CHECK), no overlapping delegation of the same delegator for the same scope, and no reverse delegation overlapping in time (prevents cycles). Delegation is **not transitive**: a delegate acts only on approvals assigned directly to the delegator.
- A delegate sees and decides only those pending approvals; the approval keeps the original approver and records the acting member and the delegation used. Delegation grants no other permission. Creation and revocation are audited and the delegate is notified.

### Fulfillment (P6-6)
- `FULFILLMENT` steps follow the approval steps. Members holding `request.fulfill` on the request perform them in order (the first one moves `APPROVED → IN_FULFILLMENT`, the last `→ COMPLETED`), with an optional note, version-checked. No inventory, procurement, payroll or accounting.

### Effects and the Phase 7 boundary (P6-8)
- A version may declare `effects.attendance = { mode: LEAVE | REMOTE | BUSINESS_MISSION | SHORT_LEAVE, dateField }`. On final approval the engine writes one `request_effects` row (unique per request and kind; tenant-bound; tied to the request, pinned version and decision event) and an outbox event `request.approved`; an administrator cancellation marks it `REVOKED` and emits `request.effect.revoked`. The worker consumer only verifies and acknowledges these events until Phase 7 materializes attendance from them. No attendance data is created in Phase 6.

### SLA reminders (P6-9)
- Steps may set `sla_hours`; approvals get `due_at`. A worker sweep sends **one** overdue reminder per approval (and to its active delegates), deduplicated by the notification key and a `reminded_at` marker.

### Visibility, notifications, audit
- `request.view` scopes evaluate the requester (SELF/TEAM), the requester's department (DEPARTMENT) and the request's project (PROJECT, from the first `project` field). Requesters always see their own requests; assigned approvers (and active delegates for pending ones) see requests they act or acted on; drafts are private. Out-of-scope requests are 404, visible-but-forbidden actions 403.
- Notifications use the outbox with deduplicated keys; email recipients are re-checked right before sending (the Phase 3 pattern). Emails never contain form data or comments. Real-time hints use the existing SSE channel (`request.changed`).
- Audited: request type and workflow changes (draft created/updated/discarded, published), delegation created/revoked, approvals and rejections, reassignment and administrator cancellation. Ordinary request activity is recorded in the append-only `request_events` history, not in audit.

### Deferred / deviations from the logical model
- `on_behalf_of_member_id` (requests on behalf of others) and free-form request comments are not in the Phase 6 roadmap and are deferred; decision comments and cancellation reasons are kept.
- `effects` and `fulfillment` live on the workflow version instead of the request type; `fulfillment_required` is derived from the steps.
- `approval_delegations.request_type_ids uuid[]` → optional single `request_type_id` with a composite FK.
- `workflow_steps.approver_rule jsonb` → typed columns with composite FKs; `is_fulfillment` → `kind`.
- `request_approvals.delegated_from_member_id` → `decided_by_member_id` + `delegation_id` (the original approver stays in `approver_member_id`).

### Decisions made during implementation
- **`request.admin` is privileged** (`PRIVILEGED_PERMISSIONS`): administering workflows decides who approves what, so it needs a fresh second factor like the other administration permissions. Without it the API answers `401 MFA_REQUIRED` and the web app offers step-up.
- **Requesters never fulfil their own request**, even when they hold `request.fulfill` (separation of duties, `403`).
- **Reassignment refuses members already assigned** to the current step, so an ALL step cannot be satisfied by one person twice.
- **Role approvers must grant `request.approve`**: publishing rejects a `ROLE` step whose role does not include it, so a step cannot silently resolve to nobody.
- **Draft saves are lenient, publish is strict**: saving a draft accepts non-structural issues (for example a condition pointing at a field that is still being edited) and reports them; publishing rejects them (`steps.N.condition.rules.M` paths).
- **One shared condition evaluator** (`packages/shared`, type checks in `packages/validation`) is used by the engine, the publish checks and the web form/builder, so visibility and routing can never disagree.
- **Idempotent replay compares normalized content** (type, form data with blank values dropped) for every status; a replay of the same content returns the existing request (`201`, same id), different content is `409 CONFLICT`, and a malformed key is `400`.
- **Repeating an identical decision is idempotent** (`200`, same version); a conflicting decision is `409 REQUEST_ALREADY_DECIDED`. The requester cancelling after approval is `409 INVALID_TRANSITION` (only `request.admin` cancels approved requests).
- **The step-approver CHECK constraint was corrected in a follow-up migration** (`20261007100000_requests_step_approver_check`): the original compared a NULL approver type with `IS NOT DISTINCT FROM` and rejected every fulfillment step. The replacement is NULL-safe with the same rules; the applied migration was not edited.
- **The request view returns `references`** (display names of members and projects chosen in form fields) so the detail page never needs directory access the viewer may not have.
- **Delegation audit entity type** is `approval_delegation`; the member pickers in the builder and the delegation form use the employee directory.
- **The `request.approved` consumer only acknowledges** (`{ requestId, effectId }`) until Phase 7; SLA reminders (`REQUEST_APPROVAL_OVERDUE`) are sent once per assignment.
- **Email re-check**: a recipient whose membership is no longer active at send time is skipped (`skipped_inactive`), not emailed.
- **Attachments** reuse the Phase 2 storage foundation and its reserved owner type `REQUEST`; access follows request visibility (requester, assigned approvers and delegates, `request.view` scope).
- **Seeded workflows** always start with the direct manager, then add conditional steps (HR for unpaid leave; technical manager and organization admin for software access; department manager from 10,000 and general manager from 100,000 for purchases; project manager for project missions) so demo data exercises conditional routes.
- **Retention purges take the organization from the trusted tenant context** (`requireAnyTenantContext`), never from a caller argument; a cross-tenant negative test covers it.
- **Builder rows keep stable React keys** (a `WeakMap` of row objects) so editing or reordering fields, steps, options and rules never mixes up inputs.
- ESLint `no-unused-vars` uses `ignoreRestSiblings` so rest destructuring can drop properties without disables.

## Consequences
- Historical requests are reproducible: pinned version, stored route, frozen approvers, immutable form data and append-only history, enforced by the database.
- Organizational changes do not rewrite past assignments; administrators resolve stalled steps explicitly and traceably.
- Phase 7 consumes approved-request effects without Phase 6 inventing attendance data.
