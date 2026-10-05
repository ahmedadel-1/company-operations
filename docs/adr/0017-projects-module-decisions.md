# ADR-0017: Projects module decisions (Phase 2)

Date: 2026-10-03 · Status: Accepted

## Context
Phase 2 delivers customers, projects, project membership, work locations, daily reports with attachments, derived missing reports and the project activity timeline (ROADMAP P2-1…P2-7). The logical model (`DATA_MODEL.md` §4), the RBAC baseline (`SECURITY.md` §2) and the attachment foundation (P1-14) leave several decisions open or describe them in a way that does not hold up against tenant isolation, least privilege or correct business dates. This ADR records how they were resolved. The priority order followed: specification, repository documents, earlier ADRs, least privilege, tenant isolation, data integrity.

## Decision

### PROJECT scope and reach
- A member's PROJECT reach is the set of projects where their employee profile is a project member, the project manager or the technical manager. It is resolved per request with tagged SQL bound to the organization (`platform/db/sql/project-reach.ts`). Archived projects stay in reach so their history remains readable; the lifecycle blocks writes.
- Whenever any grant needs reach, all three reach sets (TEAM, DEPARTMENT, PROJECT) are resolved. Reach only widens a grant held at the matching scope, so resolving all sets never grants anything by itself. An earlier optimisation skipped sets for scopes the member held no grant at; it broke Phase 1 reach checks and was removed.
- Lists filter in the database by the same rule (`listScope`). Detail reads outside reach return `404 NOT_FOUND`, never `403`, so a project's existence is not disclosed.

### Membership
- Changes need `project.assign_members` on the project.
- Assigners whose grant is project-scoped (rather than organization-wide) are restricted to prevent privilege escalation:
  - they cannot appoint, change or remove the `PROJECT_MANAGER` and `TECHNICAL_MANAGER` project roles;
  - they cannot add, change or remove themselves;
  - they cannot add an employee whose PROJECT-scoped grants exceed what the assigner holds on this project. Joining a project activates those grants, so for example a project-scoped PM cannot add a TEAM_LEAD, who would gain `support.resolve` on the project.
- Disabled or terminated employees cannot be added. Duplicates are rejected by the unique key and reported as `409 CONFLICT`.
- Removing a member deletes the membership row (a hard delete of a link, not of a business record). History is preserved in the audit log, the activity timeline and the person's submitted reports. Disabled people stay visible in member lists and history, labelled as inactive.

### Projects
- **Codes and numbers.** `number` comes from the organization counter `PRJ` (atomic `UPDATE … RETURNING` in the creating transaction). `code` defaults to `PRJ-<number>`; when a manually entered code already uses that value, the next number is taken. `code` is `citext` with a pattern CHECK and is unique per organization.
- **Status lifecycle.** Transitions follow `STATUS_TRANSITIONS`:
  - PLANNING → ACTIVE or ON_HOLD;
  - nothing jumps straight from PLANNING to COMPLETED;
  - live projects are not re-planned.
- **Archive and restore.** ARCHIVED is reached only through archive, which is allowed from PLANNING, ON_HOLD or COMPLETED. A database CHECK ties `archived_at` to the status. Restore returns the project to ON_HOLD. Archive and restore need organization-wide `project.manage`.
- **Health** is always set manually and requires a note. No score is computed.
- **Optimistic concurrency.** Every mutation of a project carries `version`; a stale version is `409 VERSION_CONFLICT`.
- **Time zone.** `projects.time_zone` (nullable IANA zone; null means the organization zone) is added to the logical model. Field projects may run in a different zone from the organization, and the report date must be the local date where the work happened.

### Daily reports
- One report per project, reporter and business date (unique key). `report_date` is computed in the project's effective time zone; `submitted_at` is UTC.
- Reports may be submitted for today or up to **7 days back**, never for future dates. They **cannot be edited** after submission; corrections are a later report or a follow-up note. This keeps submitted operational records trustworthy without a revision model in V1.
- The policy lives in `projects.daily_report_policy`: `{ required, weekdays, dueLocalTime, reporterRoles }`.
  - `reporterRoles` is an array of project roles (default `["FIELD"]`) instead of the single `reporterRole` in the logical model, because support and QA staff also report on some projects.
  - Empty `weekdays` means the organization's work week.
- Only project staff with `daily_report.submit` can submit, and only while the project is ACTIVE or MAINTENANCE.

### Missing reports
- Missing reports are derived, never stored. A report is expected for each member holding a reporter role, on each reporting weekday from the member's start date (and the project's start date), up to yesterday. Today's report counts as missing only after the due time. Everything is computed in the project's time zone.
- Queries are limited to 31 days and use the `(org, project_id, report_date)` and `(org, reporter_profile_id, report_date)` indexes.
- The `daily-report.missing.check` job notifies each missing reporter once per project and date. It also sends the project manager **one summary per project and date**. Both use notification dedupe keys, so re-runs and retries never duplicate notifications.

### Attachments on daily reports
- **Types and size:** JPEG, PNG, WebP and PDF up to 10 MB, verified by content sniffing on completion (SVG and HTML are rejected).
- **Upload:** only the reporter can upload, while the project is neither COMPLETED nor ARCHIVED.
- **View and download:** anyone who can view the report.
- **Delete:** the reporter or a holder of `project.manage` on the project, unless the project is archived.
- **Deleting** marks the attachment `DELETED` and enqueues `attachment.object.delete` in the same transaction. The worker (`maintenance` queue) then deletes the stored object in a system tenant context of the event's own organization. The API response therefore never depends on object storage being available, and a storage outage cannot leave a deleted row pointing at a live object without a retry.
- Avatars (P1-14) are replaced or cleared, never deleted directly. Replacing or clearing a photo retires the previous one: it is marked `DELETED` and its object is removed through the same outbox event, so a removed photo cannot be downloaded any more. Avatars are not listable through `GET /attachments`. The browser upload widget is shared by daily reports and avatars.

### Activity timeline
- `project_activity` is a read model.
  - Producers enqueue `project.activity.recorded` in the business transaction.
  - The `projects` queue consumer writes one entry per outbox event, idempotent by `source_event_id`.
  - Entries carry a stable `type` and `summary_params`; the UI renders localized text, never server-rendered prose.
- Timelines can be rebuilt from the retained outbox events with `pnpm activity:rebuild --org <slug> [--project <code>]`. Daily-report entries are shown only to callers who may view the project's reports.

### Out of scope
Global search (P8-6) is not implemented; the project list has a name/code filter only. There are no task or issue features ("no Jira-like tasks"), no support team assignment (Phase 3) and no `search_vector`.

## Consequences
- The schema deviates from the logical model in the listed columns, documented in the "Phase 2 — projects" section of `DATA_MODEL.md`.
- Escalation rules, reach, the composite foreign keys, missing-report time zones, the attachment rules and idempotency are covered by unit and integration tests against PostgreSQL, and the main flows by Playwright.
- Later modules (support, attendance) reuse PROJECT reach, work locations and the attachment widget without changes.
- Outbox events of type `project.activity.recorded` must be retained for as long as timelines should be rebuildable. A future retention policy for outbox events must account for this.
