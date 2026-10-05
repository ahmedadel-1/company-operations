# ADR-0018: Support operations decisions (Phase 3)

Date: 2026-10-03 · Status: Accepted

## Context
Phase 3 delivers support tickets end to end (ROADMAP P3-1…P3-11): taxonomies, the ticket lifecycle, assignment, comments and internal notes, watchers, append-only history, SLA policies with business calendars, the SLA sweep and escalation rules, ticket attachments, the email channel, Server-Sent Events and the project Support tab. The logical model (`DATA_MODEL.md` §5), the RBAC baseline (`SECURITY.md` §2.5) and ADR-0011 (email and SSE in Phase 3) leave several decisions open. This ADR records how they were resolved, in the priority order repository documents → earlier ADRs → master specification → existing implementation → safest practice.

## Decision

### Support and Jira are separate
- `WAITING_FOR_DEVELOPMENT` is a status only. No Jira issue is created, searched, linked or simulated, and the UI says so on the ticket ("No Jira issue is linked in this release"). Jira links (`JIRA_LINKED`, `JIRA_STATUS_SYNCED`) and GitHub links from the logical model are deferred to Phases 4 and 5; no columns, endpoints or placeholders exist for them.

### Ticket model
- **Numbers and keys.** `number` comes from the organization counter `SUP` inside the creating transaction; the display key is `SUP-<number>`. `(organization_id, number)` is unique.
- **Priority is derived from severity** (CRITICAL → P1, HIGH → P2, MEDIUM → P3, LOW → P4) when a ticket is created. Only members holding `support.triage` may set a different priority, at creation or later. Reporters choose severity and impact, never priority.
- **Idempotent creation.** `POST /support/tickets` accepts an optional `Idempotency-Key` (UUID). The key is unique per organization and reporter. A retry with the same key and the same content returns the original ticket; the same key with different content is `409 CONFLICT`. The web form sends one key per form instance.
- **Optimistic concurrency.** Every ticket mutation carries `version`; a stale version is `409 VERSION_CONFLICT`. The SLA sweep updates SLA columns with a version predicate but does not bump `version`, so a sweep never invalidates a form the user is editing.
- **Plain-text comments.** Comment bodies (1–10 000 characters) and descriptions are stored and rendered as plain text with preserved line breaks. No Markdown or HTML is rendered, so there is nothing to sanitize and no stored-XSS surface.
- **Attachments belong to the ticket**, not to individual comments: JPEG, PNG, WebP, PDF, plain text and CSV, up to 10 MB, verified by content sniffing. Uploading requires `support.comment` on an unlocked ticket. Deleting requires `support.triage` on an unlocked ticket. Viewing follows ticket visibility. Completed and removed attachments are recorded in the ticket history (`ATTACHMENT_ADDED`, `ATTACHMENT_REMOVED`) in the same transaction, through an optional `recordChange` hook on the attachment owner policy. The `SUPPORT_COMMENT` owner type stays reserved and unused.

### Lifecycle
- The state machine (`ticket-state-machine.ts`) is pure and exhaustively unit-tested. Every API response carries `access.transitions`, the transitions the caller may perform right now. The UI renders exactly those, and the server re-checks them.
- **Resolve, verify and close are distinct steps.** Resolving never closes a ticket, and nothing closes it automatically. The reporter (or a holder of `support.verify`) confirms the fix, and a holder of `support.close` closes the ticket. Closing a resolved ticket without verification needs `support.close`.
- **Notes.** Resolving needs a resolution note (stored as `resolution_note` and shown on the ticket). Escalating, cancelling and reopening need a reason. Transition notes are public, visible to everyone who can see the ticket. Confidential context goes into internal notes.
- **Reporter rights.** The reporter may cancel their own ticket while it is NEW, may verify, and may reject a resolution (reopen with a reason). Nothing else is granted without permissions.
- **Locking.** CLOSED and CANCELLED tickets reject comments, attachments, edits and assignment with `409 INVALID_TRANSITION` until they are reopened. CANCELLED is terminal.
- **Reporter replies resume work.** A public reply by the reporter while the ticket is WAITING_FOR_CUSTOMER moves it to IN_PROGRESS. This is recorded as a system-reasoned status change and resumes the SLA clock.

### Assignment and queues
- A ticket can have an assigned team and one assignee. The assignee must be an active, actively employed member who holds `support.view` and `support.comment` on the ticket in their own right (evaluated as if the ticket were unassigned, so an assignment cannot justify itself). If a team is set, the assignee must belong to it; archived teams cannot be assigned. Disabled members are never offered or accepted. Every change is audited and recorded in the history.
- New project tickets are routed to the project's **support team** (`projects.support_team_id`, set on the project Support tab by `project.manage` holders; audited, with a `project.support_team_changed` activity entry).
- **Queue views** are allow-listed presets: `open`, `assigned_to_me`, `reported_by_me`, `watching`, `unassigned`, `untriaged`, `critical`, `sla_risk` and `all`. They combine with allow-listed filters (status, severity, priority, SLA state, project, category, component, team, assignee, text) and sorts (`createdAt`, `updatedAt`, `priority`). All lists use keyset cursor pagination; forged or tampered cursors are `400 VALIDATION_FAILED`. Members whose `support.view` is SELF-only are offered only "Reported by me" and "Watching". The API scopes every list regardless of the view.
- **No performance scoring.** No per-person counts, rankings or resolution-time league tables are computed or shown. The project tab shows ticket counts only.

### Authorization
- Visibility: tickets in the caller's `support.view` scope (ORG, DEPARTMENT, PROJECT, TEAM, SELF; SELF and TEAM match the reporter and the assignee). Watching requires visibility; it never grants it.
- **Reporters keep their own tickets.** `support.view`, `support.comment` and `support.verify` held at *any* scope also cover tickets the member reported (`holdsOnTicket`, `reporterScopeOf`). Without this, a field employee — whose baseline grants are PROJECT-scoped — could file a project-less ticket and immediately lose access to it, contradicting the `SECURITY.md` §2.5 note that reporters always see their own tickets. The rule never extends to internal notes, triage, assignment, escalation, resolve or close, and never to other members' tickets. It was found by the Phase 3 Playwright run and is covered by an integration regression test. Out-of-scope reads are `404 NOT_FOUND`. A visible ticket with a missing action permission is `403 FORBIDDEN`. Tickets of another organization never resolve.
- **Internal notes never leak.** Notes are returned only to holders of `support.internal_note` on the ticket. They are excluded from comment lists, history (`INTERNAL_NOTE_*` events), notifications (`requires: support.internal_note`), emails (never sent for notes) and error messages. Editing someone else's note is `404`. The audit log records note ids, never note bodies.
- **Component lists are scoped.** Without a project, non-admin callers get only global components. With a project, the project must be visible to the caller (`404` otherwise). This keeps project component names inside the project.

### History versus audit
- `support_ticket_events` is the user-facing, append-only ticket history: it is localized from `type`, `from`, `to` and `metadata`, never server-rendered prose, and is protected by `BEFORE UPDATE/DELETE/TRUNCATE` triggers.
- `audit_logs` remains the security record of who changed what (assignment, configuration, transitions), without comment or note bodies.
- `sla_events` records SLA conditions (at risk, breached, paused, resumed, escalated) and is also append-only. A partial unique index `(org, ticket, kind, level)` guarantees each condition is recorded once.

### SLA
- **Policy selection.** Active policies are evaluated in ascending `priority` order. The first whose `match` (severities, priorities, projects, categories; an empty list matches everything) fits the ticket applies. The policy is re-selected when one of those fields changes, and the change is recorded as `SLA_POLICY_CHANGED`. A policy either runs around the clock or uses a business calendar (`business_hours_only` ⇔ `business_calendar_id`, enforced by a CHECK). The calendar time zone defaults to the ticket's project zone, then the organization's.
- **Business time.** Business hours are computed in the calendar zone with `Intl` (DST-correct; no fixed offsets). Weekends and holidays count as zero time. Unit tests cover weekends, holidays, DST gaps and overlaps, pause/resume, already-breached and already-resolved tickets.
- **First response** is the first public reply by someone other than the reporter. Internal notes, status changes and the reporter's own replies do not count.
- **Pause.** The resolution clock pauses in the policy's pause statuses (default WAITING_FOR_CUSTOMER) and stops in RESOLVED/VERIFIED/CLOSED/CANCELLED. Paused time is accumulated in clock seconds and added to the due dates on resume.
- **Breaches are sticky.** Once a target is BREACHED it stays breached, even if a later edit (severity change, policy edit) would move the due date out again; the history and `sla_events` keep the fact. A target that was met stays MET.
- **Policy edits apply at the next sweep.** Changing a policy does not rewrite tickets synchronously; the sweep recomputes due dates and states from `sla_started_at`, paused time and the current policy.
- **The sweep** (`sla.sweep`, every `SLA_SWEEP_INTERVAL_MS`, per organization in a system tenant context) iterates open tickets in id-ordered batches. It updates SLA columns, records new conditions and applies escalation rules. Rules (levels 1–5; triggers: resolution elapsed %, unresolved after N minutes, first response breached) only ever raise `escalation_level`. Each level notifies the configured organization roles, project roles and members once. Re-runs and retries are idempotent through the unique indexes and notification dedupe keys.

### Notifications, email and real time
- Ticket notifications are written through the outbox with the dedupe key `<type>:<ticketId>:<causeEventId>`, so retries and replays never duplicate them. The actor is never notified of their own action.
- **Email** is a separate delivery: a notification flagged `email: true` gets one `notification_deliveries` row (unique per notification and channel), sent by the worker through the `EmailChannel` port (nodemailer SMTP; Mailpit in development and e2e). Each delivery records its status (`PENDING → SENDING → SENT | FAILED | SKIPPED`), attempts, last error (truncated, no secrets) and `sent_at`. BullMQ retries with backoff; exhausted jobs stay visible on the failed-jobs admin screen. A delivery is never sent twice. Templates are localized (en/ar) and HTML-escaped. Emails exist only for assignment, escalation, SLA at risk/breached, resolved, verified, and replies between reporter and support — never for internal notes.
- **SSE.** `GET /api/v1/notifications/events/stream` subscribes to Redis channels named `rt:org:<orgId>:user:<userId>` and, for ORG-wide `support.view` holders, `rt:org:<orgId>:perm:support.view`. Channel names are built only on the server from the session's active organization. Events carry `{ type, entityType, entityId }` only; the client re-fetches through the authorized API. Streams send heartbeats, re-check the session every minute (without extending it), close when the session ends or the grants change, and are limited to five per user per API process. Publishing failures never fail a committed business operation.
- `GET /me` returns `activeOrganization.memberId`, so the web app can identify the caller in watcher and assignment lists without an extra request.

### Known upstream warning
- `@prisma/adapter-pg` 7.10 triggers pg's `DeprecationWarning: Calling client.query() when the client is already executing a query` during integration tests. It comes from the adapter, not from application code; it is harmless on pg 8 and is tracked for the Prisma upgrade before pg 9.

## Consequences
- The schema adds 11 tables, `projects.support_team_id`, CHECK constraints for every domain rule that can be expressed in SQL, partial indexes for open-ticket SLA scans and once-only SLA events, and append-only triggers. Deviations from the logical model are listed in `DATA_MODEL.md` ("Phase 3 — support").
- The lifecycle, SLA arithmetic, authorization (including internal-note secrecy), idempotency, cursors, the sweep, email delivery and SSE are covered by unit and integration tests against PostgreSQL, Redis and Mailpit. The main flows are covered by Playwright.
- Phase 4 adds Jira links to tickets without changing the lifecycle: WAITING_FOR_DEVELOPMENT stays a plain status, and links are new history event types.
