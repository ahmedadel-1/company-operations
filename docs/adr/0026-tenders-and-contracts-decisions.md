# ADR-0026: Tenders and contract lifecycle decisions (Phase 10)

Date: 2026-10-05 · Status: Accepted (Phase 10)

## Context
Phase 10 adds the commercial domain: tenders (pre-award opportunities), the Corporate Document Vault, contracts (post-award agreements) with obligations, milestones, guarantees, amendments and renewals. It had to reuse the existing tenancy, authorization, attachments, outbox, notification, audit, dashboard and search infrastructure without redesigning any of it, and without corrupting the Phase 6 request model to claim approval reuse.

## Decisions

### 1. Module boundary
One `commercial` module in `packages/core/src/modules/commercial` (services, contextual access, monitor) with a pure `engine/` (state machines, readiness, projection, recurrence, health, dates, money) that has no database access and is unit-tested exhaustively. HTTP controllers live in `apps/api/src/modules/commercial`; the scheduled job in `apps/worker/src/processors/commercial`. Tables are prefixed by aggregate (`tenders`, `tender_*`, `contracts`, `contract_*`, `corporate_documents`, `commercial_documents`, `guarantees`, `commercial_reminders`, `commercial_settings`); every table carries `organization_id` with composite `(organization_id, id)` foreign keys (ADR-0003).

### 2. Approval architecture (no fake requests)
The Phase 6 persisted model is coupled to `request_instances`; tenders and amendments are not employee requests. Decision:
- **Reused:** the pure step evaluation (`stepOutcome` from `modules/requests`: ANY_ONE / ALL, any negative decision closes the step), the optimistic-concurrency and aggregate-lock patterns, notifications through the outbox, the audit writer.
- **Domain persistence:** `tender_review_gates` + `tender_reviews`. A review request opens one *round*: TECHNICAL / COMMERCIAL / LEGAL gates open together (each optional, ANY_ONE or ALL), the FINAL gate is always present and opens when the others are approved. FINAL reviewers need `tender.approve`, the other gates `tender.review`. FINAL approval re-checks readiness and moves the tender to READY_FOR_SUBMISSION; CHANGES_REQUIRED or REJECTED returns it to PREPARING and supersedes the rest of the round.
- **Amendments:** `contract_amendments.status` DRAFT → UNDER_REVIEW → APPROVED → EFFECTIVE (or REJECTED / CANCELLED). Approval is four-eyes: `contract.approve` and never the author.
- No second generic approval framework was created.

### 3. Tender lifecycle
DRAFT → NEW → (UNDER_REVIEW) → BID_DECISION_PENDING → PREPARING or NO_BID → INTERNAL_REVIEW → READY_FOR_SUBMISSION → SUBMITTED ⇄ CLARIFICATION → AWARDED or LOST → ARCHIVED; CANCELLED from any open state (reason required). Only plain administrative moves use the generic transition endpoint; NO_BID, PREPARING (from a decision state), INTERNAL_REVIEW, READY_FOR_SUBMISSION, SUBMITTED, AWARDED and LOST are reachable only through their controlled operation, which checks its own prerequisites (`engine/tender-state.ts`). The bid decision may be re-recorded while NEW … PREPARING; each decision is a new `tender_bid_decisions` row, never an overwrite. Submission, award, loss and create-contract take an `Idempotency-Key`. Only DRAFT tenders can be deleted (the database refuses other deletes); everything else is cancelled or archived.

### 4. Readiness formula (one formula everywhere)
`percent = floor(approved applicable mandatory × 100 / applicable mandatory)`. NOT_APPLICABLE requirements are excluded from every denominator, and only a requirement manager may set it. With no applicable mandatory requirement the state is NO_MANDATORY with a null percentage (never a misleading 100 %). Optional requirements are counted separately and never affect the state. Counters are stored on the tender and recomputed in the transaction of every requirement change; detail, list, dashboard, Needs Attention and reports read the same counters (`engine/readiness.ts`).

### 5. Deadline and date model
- **Tender deadlines are instants:** `submission_deadline_at timestamptz` plus `submission_deadline_time_zone` (IANA). The UI enters and shows local time in that zone; the API stores UTC. After intake (status beyond NEW) the deadline changes only through an addendum, which keeps the previous deadline and records its source.
- **Legal dates are calendar dates** (`date`): contract start/expiry, obligation and milestone due dates, guarantee and document expiry. They are compared with the organization's local "today" (organization time zone), never host time.
- **Reminders** are due from 09:00 local time on `date − threshold` days (DST-safe); the smallest due threshold wins, so a monitor that was down sends one reminder, not every missed threshold. Reminders are de-duplicated by `commercial_reminders (entity, kind, threshold, due date)`.
- **Renewal notice deadline** = current expiry − notice period in calendar days.

### 6. Money
`numeric(19,4)` in PostgreSQL, `Prisma.Decimal` in memory, a decimal string on the wire, an ISO 4217 code per record. Never a JavaScript number; amounts in different currencies are never added or converted. Dashboards and reports total per currency.

### 7. Corporate Document Vault and commercial documents
- **Corporate documents** are reusable company records (registrations, certificates, bank letters …) with append-only `corporate_document_versions`, each with its own validity. The document mirrors the latest version's expiry for queries and reminders. Requirements link to a specific *version* (`tender_requirement_links`), so later uploads never change what a submitted tender used.
- **Tender and contract documents** (`commercial_documents` + versions) add business metadata and versions over the existing attachment service; binaries are never duplicated, and download authorization goes through registered attachment policies.
- **Classification:** GENERAL, COMMERCIAL_CONFIDENTIAL, LEGAL_RESTRICTED, BANKING_RESTRICTED. Non-GENERAL commercial documents need `commercial_document.view`; non-GENERAL corporate documents need `corporate_document.restricted.view`. A hidden document leaves no trace for the caller: it is filtered in SQL before any list, count, page, search, dashboard or Needs Attention number is produced; requirement links to it are omitted; submission evidence, addendum, amendment, renewal-action and occurrence-evidence references to it read as null; its timeline events are not returned; writes naming it fail as not found; and its attachments return 404.

### 8. Financial confidentiality
Tender estimates, bid and award values, contract values, amendment value deltas and guarantee amounts are returned only to callers holding `tender.financial.view` / `contract.financial.view` in scope for that record; otherwise the field is absent (not null, not zero) and a `hasValueChange`-style flag says a value exists. The same rule drives detail, lists, search snippets, dashboards (money tiles only with the permission), the project Commercial tab and CSV exports (money columns only for holders, blank outside scope; `contracts-by-value` requires the permission). `SENSITIVE_COMMERCIAL_PERMISSIONS` can be granted by a non-ORG_ADMIN role manager only when they hold the permission at ORG scope.

### 9. Contextual authorization
FULL access: the record is inside the caller's `tender.view` / `contract.view` scope (owner and leads for SELF/TEAM, the owner's department for DEPARTMENT, the linked project for PROJECT) or, for tenders, the caller is an assigned reviewer. INVOLVED access: the caller owns or reviews a requirement, owns an obligation, occurrence or milestone, or owns a guarantee of the record; they see the header, GENERAL documents and their own items, never money. Anything else, and every foreign-organization id, is 404.

### 10. Contract lifecycle and projection
- DRAFT → UNDER_REVIEW → AWAITING_SIGNATURE → ACTIVE ⇄ RENEWAL_REVIEW / SUSPENDED → EXPIRED / TERMINATED → CLOSED. The two signing steps need `contract.approve`; suspension, termination and early closure need a reason. EXPIRING (ACTIVE or RENEWAL_REVIEW within 90 days of the current expiry) and RENEWED are derived, not stored. Contracts are never deleted.
- **Baseline vs projection:** currency, original value, original expiry and source tender are editable only in DRAFT and never rewritten afterwards. `current_value`, `current_expiry_date` and `renewal_notice_deadline` are rebuilt from the baseline plus EFFECTIVE amendments (value deltas add; a new expiry replaces) and RENEWED/EXTENDED renewal actions (a new expiry replaces), in application order, last date change wins. Rebuilds run under the contract's aggregate lock with a version check, so concurrent activations serialize.
- **Renewal:** renewal actions (REVIEW_STARTED, RENEW, DO_NOT_RENEW, NOTICE_SENT, RENEWED, EXTENDED) are explicit, audited, idempotent records with optional evidence. Nothing renews silently: a live contract past its current expiry becomes EXPIRED (monitor, system event), and AUTO_RENEWAL still expects a recorded decision.
- **Health:** deterministic reasons with fixed severities (`engine/health.ts`), the most severe wins; stored on the contract, refreshed in the transaction of every relevant change and daily by the monitor.

### 11. Obligation recurrence
NONE, MONTHLY, QUARTERLY or YEARLY from the first due date, keeping the day of month and clamping to the month end. No free-form rules. Occurrences are the work items; they are generated up to a rolling 90-day horizon (at most 24 per pass), optionally bounded by "repeat until", and are unique per (obligation, due date), so regeneration is idempotent. Evidence-required occurrences need a document version or attachment before completion; waivers need a manager and a reason; nothing completes automatically.

### 12. Dashboard, Needs Attention and search
The commercial dashboard (`/dashboards/commercial`) and the executive dashboard cards count with the same row-filter builders as the lists they link to (`tenderListWhere`, `contractListWhere`, `corporateDocumentListWhere`), cached 60 s with per-domain version invalidation on every commercial change. Needs Attention adds commercial item types (tender deadline at risk, overdue requirements, tender reviews and final approvals waiting, contract notice deadlines, renewal decisions, expiring contracts, overdue obligations and milestones, expiring or expired guarantees, amendments awaiting approval, expiring corporate documents) that deep-link to the record tab or open the document in the vault. Global search gains `tenders`, `contracts` and `documents` groups that use the same visibility rules.

### 13. Background job
One repeatable `commercial.monitor` job on the `commercial` queue (`COMMERCIAL_MONITOR_INTERVAL_MS`, default 15 min) visits only organizations with commercial records, in batches of 200: reminders, calendar-driven expiry of contracts and guarantees, occurrence generation up to the horizon, health refresh, dashboard invalidation. Each step is idempotent and harmless to re-run.

### 14. Out of scope
AI analysis, OCR, scraping, portal automation, automatic submission, e-signature, supplier portal, pricing, invoicing, payments, accounting and ERP procurement. Integration points are limited to the document/version model and the outbox events; no speculative frameworks were added.

## Consequences
- New permission keys (`tender.*`, `contract.*`, `corporate_document.*`, `commercial_document.view`) materialized into existing organizations by the migration with the §2.5 baseline; existing grants unchanged.
- Approval logic is shared at the evaluation level only; tender and amendment approvals have their own tables and audit trail.
- The projection makes current values a cache of the baseline plus history: it can always be rebuilt and is verified by tests.
- Status changes of contracts and tenders' controlled operations use the `sensitive` per-user rate-limit bucket (ADR-0016).
