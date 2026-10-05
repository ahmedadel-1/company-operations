# UI / UX Specification

Status: Phase 0 baseline (2026-10-02); the Phase 1 shell (P1-17) is implemented. Module screens arrive in their phases (`ROADMAP.md`).

**As implemented in Phase 1** (`apps/web`, components in `packages/ui` on `radix-ui` primitives):
- Shell per §1: 240 px sidebar at ≥ 1024 px, 64 px icon rail at 768–1023 px, bottom bar (Home, Employees, Notifications, More) with a "More" sheet below 768 px. Navigation is built from `/me` permissions; admin groups are hidden from members without the permission, and direct visits show an access-denied page.
- Screens: Home (minimal), Profile, Employees (table ≥ 768 px, card list below), employee detail (edit, account access, invitation, roles), Departments, Teams and team detail, Notifications, Admin → Organization, Roles, Job titles, Audit log (filters + detail dialog), System jobs (failed jobs).
- Session states as full screens or dialogs: signed out (with the reason from `authError`), session expired, MFA required ("Verify now" starts step-up and returns to the same page), forbidden, no active membership.
- Employee avatars are API-only in Phase 1 (upload intent → pre-signed PUT → complete → `PUT /employees/:id/avatar`, covered by integration tests). The browser upload widget needs the S3 public endpoint in the CSP and bucket CORS, and is built with the first attachment UI (daily reports, P2-6).
- Confirmations of user actions are inline `role="status"` messages; no toast library is used in Phase 1 (sonner is not a dependency).
- Dropdown menus (account menu, organization switcher) are non-modal, so the rest of the page is not hidden from assistive technology while a menu is open (axe `aria-hidden-focus`).
- Language switch in the account menu (English / العربية); the choice is saved to the member profile and a non-secret `ops_locale` cookie, and `<html lang dir>` is rendered server-side. **The Arabic catalog is a machine-assisted first pass and needs review by a native speaker before an Arabic rollout.**
- Verified by Playwright: axe (WCAG 2.0/2.1/2.2 A and AA tags) with zero violations on every Phase 1 screen, dialogs and menus; navigation form and no horizontal overflow at 375, 768, 1024 and 1440 px; touch targets ≥ 44 px on mobile; RTL layout. Manual keyboard and screen-reader passes remain Phase 9 (P9-2).

Principles: **clarity over density, every number links to its records, mobile-first for field flows, honest states (never fake data), English first with Arabic/RTL readiness, accessible by default.**

---

## 1. App shell

| Region | Desktop (≥ 1024 px) | Tablet (768–1023 px) | Mobile (< 768 px) |
|---|---|---|---|
| Primary navigation | Persistent left sidebar (collapsible to icons) | Icon rail; expands as overlay | Bottom navigation bar (5 items) + "More" sheet |
| Top bar | Org name, global search (Phase 8), notifications bell, user menu | Same, search as icon | Page title, bell, user avatar |
| Content | Max width 1440 px, 12-column grid | 8-column grid | Single column, 16 px gutters |
| Context panel | Optional right panel (details, filters) | Sheet | Full-screen sheet |

- **Navigation items are permission-driven** from `GET /api/v1/me`; items the member cannot use are hidden (UX only; the API enforces).
- **Org switcher** in the user menu only when the user has more than one membership.
- **User menu**: profile, language (English / العربية), time-zone display preference, sign out.
- **Banners** (top of content, dismissible only when safe): session expiring, MFA required for this action, Jira connection needs re-auth (admins), support access session active (deferred, ADR-0010 — non-dismissible).

### 1.1 Sidebar groups (desktop)

1. Home (role dashboard)
2. Work: Projects · Support · Daily reports
3. Me: Requests · Approvals · Attendance
4. People: Employees · Departments · Teams
5. Insights: Support · Projects · Team · Executive dashboards (Phase 8; each only with its permission)
6. Admin: Organization · Roles · Integrations · Request types · Attendance config · Support config · Audit · System jobs

Groups and items appear only when at least one item is permitted and the module is delivered.

As implemented after Phase 10: Work adds Tenders (`tender.view` or `tender.create`), Contracts (`contract.view`) and Documents (`corporate_document.view`); Insights adds the Commercial dashboard; Admin adds Commercial settings. The mobile bottom bar is unchanged; the new items are in the More sheet.

## 2. Mobile navigation

Bottom bar (max 5, icon + label, 48 px min touch target):

| Slot | Default item | Notes |
|---|---|---|
| 1 | Home | Role-aware mobile home |
| 2 | Attendance | Check-in/out (Phase 7; hidden before) |
| 3 | **Report issue** (center, emphasized) | Opens ticket create (Phase 3; hidden before) |
| 4 | Requests | My requests + approvals badge (Phase 6) |
| 5 | More | Sheet with remaining permitted items |

Before Phases 3/6/7 ship, the bar shows Home, Employees, Notifications, More. Primary actions on mobile use a bottom-anchored action bar, not floating buttons over content.

As implemented after Phase 3: Home, Employees, **Report issue** (center, emphasized; members with `support.create`), Notifications, More. The support inbox and support settings are in the More sheet (and in the sidebar from 768 px).

As implemented after Phase 7: members with `attendance.self` get Home, **Attendance**, Report issue, Notifications, More; Employees moves to the More sheet. Members without `attendance.self` keep the Phase 3 bar.

## 3. Role dashboards (Phase 8; Phase 1 shows a minimal Home)

Every card shows a count or status **derived from real records** and deep-links to the filtered list. No vanity metrics; no per-person rankings from Jira/GitHub.

| Dashboard | Audience (permission) | Key sections |
|---|---|---|
| Employee home | everyone | Today's attendance state, my open requests, approvals waiting for me, my tickets, my projects, notifications |
| Field home (mobile) | members with `daily_report.submit` | Check in, report issue, today's daily report status, my site projects |
| Support | `support.view` at ORG/PROJECT + triage rights | Untriaged, critical open, SLA at-risk/breached, assigned to me, waiting for development |
| Project | `dashboard.project` | Per-project health, open incidents by severity, missing daily reports, Jira open/blocked/overdue, PRs awaiting review / failing checks, team on leave today |
| Technical | `dashboard.executive` + TM grants | Escalations, blocked Jira work, PRs awaiting review, critical incidents across projects |
| HR | `attendance.team` (ORG) + `employee.manage` | Attendance today (present/late/remote/leave), corrections pending, low-accuracy reviews pending, HR requests |
| Executive (GM) | `dashboard.executive` | **Needs Attention** feed first, portfolio health, critical incidents, SLA compliance trend, approvals waiting on me, attendance overview |

"Needs Attention" is a prioritized list of actionable items with reason, age and a direct action link.

### 3.1 As implemented (Phase 8)

- **Home `/`** for every member: quick actions first (attendance, new request, report issue, daily reports, search — each only with its permission), Needs Attention, "My numbers" (approvals waiting/overdue, my requests in approval, my open tickets, tickets assigned to me for members who work tickets), attendance today, reports due, my projects, unread notifications, links to the dashboards the member may open ("Insights") and setup progress for administrators. Phones stack the same cards in one column; there is no separate mobile route.
- **Role dashboards** under Insights: `/dashboards/support`, `/dashboards/projects` (PM, department manager, technical manager; development signals with freshness), `/dashboards/team` (team lead, department manager, HR; counts only, no locations) and `/dashboards/executive` (Needs Attention, attendance, project health, support, development, both trends). The HR and technical views are these dashboards with HR's and the technical manager's scopes. A dashboard the member cannot open shows the 403 state; its link is hidden.
- **Number tiles** are links named "{label}: {value}. Open the list"; the list opens with the same filters (the ticket and project lists name filters that have no visible control and offer "Clear filter"). Tiles without a list (missing reports today, Jira and GitHub totals) are plain text; the per-project rows link to the project's Jira or GitHub tab.
- **Freshness**: every dashboard shows "Updated {time}" with a Refresh button; Jira and GitHub cards show the last sync, "Out of date" and "Connection needs attention" badges, or "Not connected".
- **Trends**: bars plus a text summary (the chart's accessible name), the period and zone, a note on the definition and a "Show the values" table; range select (today, 7, 30, 90 days). Charts are drawn left to right in both languages; labels follow the reading direction.
- **Search palette**: Ctrl/Cmd+K or the header search field (an icon on phones) opens a dialog with a combobox input and a type filter; results are grouped by type, arrow keys move, Enter opens and Escape closes; "More {type}" pages within one type. Fewer than 2 characters shows a hint; no results says "No results you can open."
- **Setup checklist** `/admin/setup` (administrators): each item done/not done with the count it is based on and a link to its admin screen; Jira and GitHub are optional.
- **Notification preferences** `/notifications/preferences`: one row per category with in-app and email switches; locked switches are disabled with "Always on" and the page explains that security notices and critical alerts are always delivered.
- Verified at 375, 768, 1024 and 1440 px and in Arabic (RTL) with axe and horizontal-overflow checks (`apps/e2e/tests/13-dashboard.spec.ts`).

## 4. Screens per module

| Module | Screens | Phase |
|---|---|---|
| Auth & session | Sign-in redirect, signed-out, session expired, unauthorized (403 page), MFA step-up interstitial ("Verify it's you to continue") | 1 |
| Profile | My profile, preferences (language, time-zone display) | 1 |
| Organization admin | Organization settings (name, time zone and work week — required fields, no preset), roles & grants (matrix editor read-only in V1 except grants), members/invitations, system jobs | 1 |
| People | Employee directory (table/cards, filters: department, status, project), employee detail (tabs: profile, projects, attendance*, requests*), departments tree, teams | 1 |
| Notifications | Bell dropdown (latest 10), full list with read/unread filter | 1 |
| Audit | Audit log list (filters: actor, entity, action, date range), event detail with redacted diff | 1 |
| Projects | Project list (status/health filters), project detail tabs: Overview, Team, Support, Jira, GitHub, Daily reports, Activity, Settings; customer list | 2 |
| Daily reports | Mobile submit form (status, work performed, problems, photos), list, detail, missing-reports view | 2 |
| Support | Inbox (saved views: untriaged, mine, critical, SLA risk), ticket create (mobile-first with photo), ticket detail (header with severity/priority/SLA chips, timeline, comments/internal notes, links to Jira/PRs, attachments), config (categories, components, SLA policies, escalation rules) | 3 |
| Jira | Connect wizard (site → projects → mappings), import progress (≈ estimate), sync history/failures, ticket link/search dialog, create-issue dialog, project Jira tab (as built: see "As implemented (Phase 4)") | 4 |
| GitHub | Install flow, repository mappings, project GitHub tab, ticket PR panel | 5 |
| Requests | New request (type picker → dynamic form), my requests, request detail with approval timeline, **Needs My Approval** inbox (swipe-free explicit approve/reject on mobile), delegation settings, request-type/workflow admin | 6 |
| Attendance | Check-in/out (map preview optional, accuracy indicator, clear capture notice), my history, team view, HR view, corrections, low-accuracy review queue, work locations & shifts config | 7 |
| Dashboards & search | Role dashboards, global search results grouped by type, setup checklist, notification preferences | 8 |

**As implemented (Phase 2).**
- **Sidebar.** A "Work" group with Projects, Daily reports and Customers, and Work locations under administration. Each entry is shown only with the matching permission.
- **Project list (`/projects`).** Server-side pagination ("Load more"), search by name or code, filters for status, health, customer, "my projects" and archived, and allow-listed sorts. Below 768 px the table becomes cards, with the same filters. Skeleton, empty (with "Create project" when permitted), error (retry and request id) and no-access states are covered.
- **Project detail (`/projects/[id]`).** An accessible tablist (arrow, Home and End keys; `aria-controls` on the selected tab) with these tabs:
  - **Overview:** status and health chips with text, PM/TM, customer, dates, the reporting policy in plain language, and the latest missing reports;
  - **Team:** members with project role and dates; inactive people stay listed and are labelled;
  - **Daily reports:** submit form, list and missing-reports view;
  - **Activity:** localized timeline with "Load more";
  - **Settings:** edit, status change with reason, health with note, daily-report policy, linked work locations, and archive/restore.

  Support, Jira and GitHub appear as disabled tabs marked "Available in a later release", with no data. Out-of-scope or foreign projects show the generic "Not found" page.
- **Daily report.** The submit form is one column and mobile first. The detail page lists attachments.
- **Upload widget.** Used for report attachments and employee photos. It validates type and size before upload, shows a progress bar, then a "Verifying…" step, then the result. Errors are announced through `aria-live`; downloads use authorized short-lived links. Delete is offered only to the reporter or a project manager.
- **Other screens.** Employee photos appear on the profile and on employee detail (upload, replace, remove). The customers page offers list, create, edit and archive. Work-location administration offers list, create, edit and deactivate.
- **Testing.** Every Phase 2 screen is checked with axe at 375, 768, 1024 and 1440 px for serious or critical violations and for horizontal page overflow, and in Arabic (RTL) (`apps/e2e/tests/07-projects.spec.ts`).

**As implemented (Phase 3).** Decisions: ADR-0018.
- **Sidebar.** "Support" in the Work group (with `support.view` or `support.create`) and "Support settings" under administration (`support.config`).
- **Support inbox (`/support`).** A view picker with allow-listed queues, a search form (text or `SUP-<n>`, status, severity, priority, SLA state, project, sort), cursor pagination with "Load more". Members whose `support.view` is SELF-only get only "Reported by me" and "Watching"; "Assigned to me", "Untriaged" and "Unassigned" appear only to members who can work tickets. Below 768 px tickets are cards (key, title, status, severity and SLA chips with text), never a squeezed table. Skeleton, empty (separate messages for filtered, reported-by-me and general), error (retry and request id) and no-access states are covered.
- **Ticket create (`/support/new`).** One column, mobile first: summary, description, severity, impact, optional project (pre-filled from the project tab), category, component (scoped to the project), and optional photos or files (type and size checked in the browser, attached right after the ticket is created; if one fails, the form names it and links to the ticket instead of losing it). Priority is shown only to triagers. The form sends an idempotency key, so a double submit creates one ticket.
- **Ticket detail (`/support/tickets/[id]`).** Header with key, title, status, severity, priority and SLA chips (text plus colour, with the due time); a "Ticket actions" region that offers only the transitions the API reports as allowed, each in a dialog with the required reason or resolution summary; details (reporter, project, category, component, team, assignee); assignment for `support.assign` holders (eligible active members only); watchers; public replies and, for `support.internal_note` holders only, an "Internal note" option visually distinct from replies; attachments with authorized downloads; and the localized history. A WAITING_FOR_DEVELOPMENT ticket says that no Jira issue is linked in this release. Closed and cancelled tickets show as locked.
- **Project Support tab.** Open, critical and SLA-risk counts plus counts per status (scoped to the viewer), the open queue, a "Report an issue for this project" link and the support team setting for `project.manage` holders. No per-person figures.
- **Support settings (`/admin/support`).** One page with sections for categories, components, business hours (working hours per weekday, holidays, time zone), SLA policies (match, targets, at-risk threshold, pause statuses, calendar) and escalation rules (trigger, threshold, level, recipients). Each section lists active and inactive entries with a text badge and offers create/edit dialogs with an "Active" switch.
- **Role-specific UX without scoring.** Reporters see their tickets, replies and the verify/reopen step; agents see queues and actions; project managers see their projects' tickets. No leaderboards, per-agent counts or resolution-time rankings anywhere.
- **Live updates.** Ticket pages, lists and the notification bell refresh when the server announces a change over SSE.
- **Testing.** `apps/e2e/tests/08-support.spec.ts` covers the 16 Phase 3 scenarios (including mobile at 375 px and Arabic RTL) and runs axe at 375, 768, 1024 and 1440 px on the inbox, create form, ticket detail, project Support tab, support settings and the SLA policy dialog, with horizontal-overflow checks.

**As implemented (Phase 4).** Decisions: ADR-0019. The Phase 0 "connect wizard" became one administration page plus a site-choice step.
- **Sidebar.** "Jira" under administration, only for ORG-wide `integration.manage` holders (others get the 403 page on the admin URLs).
- **Jira integration (`/admin/integrations/jira`).** Connection card: site name and link, a status badge with text (Connected, Needs reauthorization, Error, Disconnected), connected time, last successful sync, webhook state and expiry, the last error as a plain-language message, the OAuth redirect URI to register in the Atlassian console, and Connect / Reauthorize / Disconnect (confirm dialog explaining that cache and links stay). After consent the page shows the outcome from the redirect (`?jira=connected`, a site chooser with missing-scope warnings when several sites are accessible, or a localized error). Without an OAuth app configured, the page says so instead of offering a broken button; without an https public URL it explains that changes arrive through reconciliation. **Project mappings**: each mapping shows `KEY → CODE`, import state, issue count, a live progress bar (`role=progressbar`, "N of about M") while a run is active, and Sync now, Deep check, Full resync, Pause/Resume, blocked-status editing and Remove. "Add mapping" opens a dialog (internal project, debounced Jira project search with already-mapped projects disabled, blocked statuses) and says the import runs in the background. Webhook delivery failures are listed at the bottom.
- **Sync history (`/admin/integrations/jira/sync`).** Runs newest first with a status filter and "Load more": `KEY → CODE`, type, status badge, counters (created, updated, unchanged, failed), queued/finished times, error summary, Cancel for active runs, Retry for failed or cancelled ones, and an expandable failure list.
- **Ticket Development panel (ticket detail).** Shown only to `jira.view` holders on the ticket. Linked issues as cards: key as a deep link to Jira (new tab, labelled), summary, status chip with text, link type, "Created from this ticket" where applicable, and Unlink (with `jira.link`). "Link issue" opens a dialog with a source switch (Synced issues / Live from Jira), an explicit Search button (no per-keystroke Jira calls), results with "Already linked" markers and a link-type choice. "Create issue" (with `jira.create_issue`) opens a dialog that states up front that only the summary and description are sent, with a link back to the ticket, and never internal notes or attachments; the description is prefilled from the public description and editable; issue types come from the mapped Jira project. Reauthorization and "not mapped" states are explained in place. History shows "Linked/Unlinked/Created Jira issue KEY" and "Jira status changed from A to B" (by System). The WAITING_FOR_DEVELOPMENT notice no longer says Jira is unavailable; it states that the ticket status does not change automatically when the Jira issue changes.
- **Project Jira tab (`/projects/[id]#jira`).** Replaces the Phase 2 placeholder for `jira.view` holders: a "Jira is the source of truth" note, counters (open, in progress, blocked, overdue, done, tickets with Jira links), mapped Jira projects with last sync time, recently updated issues with deep links, and a link to the admin page for integration administrators. No per-person figures.
- **Testing.** `apps/e2e/tests/09-jira.spec.ts` covers the 17 Phase 4 flows against the deterministic Jira double, runs axe at 375, 768, 1024 and 1440 px on the admin page, sync history, add-mapping dialog, project Jira tab, ticket panel, link dialog and create dialog with horizontal-overflow checks, and repeats the ticket panel and project tab in Arabic (RTL).

**As implemented (Phase 5).** Decisions: ADR-0020.
- **Sidebar.** "GitHub integration" under Admin, only for ORG-wide `integration.manage` holders (others get the 403 page). Privileged actions ask for MFA step-up first.
- **GitHub integration (`/admin/integrations/github`).** "GitHub stays the source of truth; no code is stored." Without App credentials the page says so instead of offering a broken button. Installation cards: account and type, status badge with text (Active, Suspended, Uninstalled, Disconnected), repository access, granted permissions with a warning for missing ones, events, connected and last-refreshed times, last error in plain language, Refresh, Manage on GitHub (new tab, labelled) and Disconnect (confirm dialog explaining that history stays and the App remains installed on GitHub). Suspended and uninstalled installations show an explanatory notice. "Install GitHub App" starts the GitHub round trip; the outcome from the redirect (`?github=installed|refreshed|requested|error&reason=…`) is shown as a localized notice. App settings list the webhook, setup and callback URLs to register. **Repositories**: name (left-to-right inside RTL), private/archived badges, sync health, mapped projects with Remove, "Map to project" (dialog with a project picker and a note that open pull requests and the last 90 days are imported in the background), Sync now, and an "unavailable" notice for repositories the App can no longer access (hidden behind "Show unavailable repositories"). **Sync runs** with a status filter, live progress, counters, Cancel, and an expandable failure list. **Webhook deliveries** with a status filter: event, action, status and outcome only, never payloads.
- **Project GitHub tab (`/projects/[id]#github`).** Replaces the Phase 2 placeholder for `github.view` holders: the source-of-truth note, counts (open pull requests, stale repositories), repository cards with last sync and an attention notice (failed, stale or unavailable) linking administrators to the admin page, and the pull-request list with a state filter: `repo#number` and title as a deep link to GitHub (new tab, labelled), draft badge, review and checks summaries as text chips, signals (Draft, Awaiting review, Changes requested, Failing checks, Sync is stale), confirmed Jira issues, suggestions with Confirm/Dismiss and unverified keys, and "Link Jira issue" (dialog searching this project's cached Jira issues) for `github.link` holders. No per-person figures.
- **Ticket pull-request panel (ticket detail).** Shown only to `github.view` holders on the ticket. Pull requests with "Via Jira" and/or "Linked to ticket" markers, review/check chips and Unlink for direct links; "Link pull request" (with `github.link`, unlocked tickets) opens a dialog searching the project's repositories by title or number with "Linked" markers. A ticket whose project has no repository says so.
- **Retention (`/admin/organization`).** "Integration record retention" card per category: current policy, last cleanup and count, days to keep (7–3650). Saving first shows how many records the next cleanup would remove and switches the button to "Confirm and save"; "Keep indefinitely" removes the policy.
- **Testing.** `apps/e2e/tests/10-github.spec.ts` covers the 17 Phase 5 flows against the deterministic GitHub double, runs axe at 375, 768, 1024 and 1440 px on the admin page, the map dialog, the project GitHub tab, the link-Jira-issue dialog, the ticket panel and the link-pull-request dialog with horizontal-overflow checks, and repeats the project tab and ticket panel in Arabic (RTL).

Phase 6 requests and approvals (as built, ADR-0021):

- **My requests (`/requests`).** Search (text or `REQ-<n>`), status and type filters, a view picker (mine / all in scope) for members with a wider `request.view` scope, "Load more" pagination; rows show key, type, status chip with text and dates. "New request" in the header. Skeleton, empty, error (retry and request id) and no-access states.
- **New request (`/requests/new`).** Type picker as cards (icon, localized name and description, category), then the dynamic form for the published version: localized labels and help, required markers, conditional fields that appear and disappear without losing focus order, inline field errors mapped from `fieldErrors` plus an error summary, attachments when the version allows them, "Submit request" and "Save as draft". A submission is sent once (idempotency key per attempt); an outdated form reloads with an explanation.
- **Request detail (`/requests/[id]`).** `REQ-n · Type` heading, status chip, submitted values (member and project names from `references`), approval timeline per step (state, approvers with their decision, delegate attribution, comments, skipped steps), attachments, append-only history, and an Actions region only for what the viewer may do (approve/reject, fulfil, cancel, reassign). Reject needs a reason; the confirm button stays disabled until one is entered. Live updates refresh the page when the request changes.
- **My approvals (`/approvals`).** Type filter; pending items with requester, type, step, an "All approvers" badge for ALL steps, due date or Overdue chip and "On behalf of …" for delegated items; explicit Approve and Reject buttons with a confirmation dialog (comment; required for rejection), no swipe gestures; works at 375 px; links to delegations. The Approvals navigation entry shows the pending count (refreshed by live updates; announced through `aria-describedby`, so the link name stays "Approvals").
- **Delegations (`/approvals/delegations`).** Current and past delegations with status; a form with a member picker (directory search), optional request type, period (at most 90 days) and reason; Revoke with confirmation. Request administrators can also delegate on behalf of another approver.
- **Request types (`/admin/request-types`).** List with active/draft/published badges and a create form (key, names, category, icon). The type page has settings (names, eligibility roles, active toggle), the version list (draft, published, retired) and the builder: fields (type, key, localized labels, limits, options, conditional visibility), steps (approver rule, ANY/ALL, condition rules, SLA hours, fulfillment), attachment policy, effects and notification toggles. Drafts save with non-blocking issues listed; Publish (confirmation dialog) reports blocking issues inline. Published and retired versions open read-only, with "Edit as new version".
- **Accessibility and RTL.** Every request screen is translated (English, Arabic), mirrors in RTL with left-to-right request keys and numbers, uses text plus color for states, and keeps keyboard order through dynamic fields and dialogs.
- **Testing.** `apps/e2e/tests/11-requests.spec.ts` covers the 20 Phase 6 scenarios (new request, dynamic form, submit, My requests, manager inbox, approve, approved status, reject, rejection reason, multi-step, conditional route, ANY/ALL, delegate acts, unauthorized cannot approve, published not editable, new version leaves old requests unchanged, attachments, mobile, Arabic RTL, notifications) plus the builder flow, and runs axe with horizontal-overflow checks on My requests, the type picker, the leave form, request detail, My approvals, delegations, the approve dialog, the request-type list and the purchase workflow builder at 375, 768, 1024 and 1440 px.

Phase 7 attendance (as built, ADR-0022):

- **Today (`/attendance`).** One large primary action (Check in / Check out, at least 56 px high and full width on mobile) with the work date, the shift and its times, the planned mode (office, remote work, business mission, approved leave with a link to the request) and the current record. A capture notice says that the position is read once, only when the button is tapped, and that it can be wrong. Geolocation outcomes have their own messages: permission denied (how to allow it, plus "Continue without location", which reports the problem and lets the server policy decide), unavailable, timeout and unsupported. There are no automatic retries or loops. A low-accuracy reading shows the measured and allowed accuracy first, with "Try again" and "Send this reading". The text tied to that button says the server still applies the organization's policy (the check-in is refused or recorded for review) and that a low-accuracy reading never counts as inside a work location, so the action cannot be read as a bypass. Server refusals (outside every work location, low accuracy, leave) use plain language without coordinates. Every attempt keeps its idempotency key, so a double tap or a retry records once. Remote and mission days ask for no location.
- **History and corrections.** History tab: "Load more" pagination; rows on wide screens and cards at 375 px (date, status chip with text, late or early minutes, Adjusted and Needs review badges). The record detail lists the evidence events in order (check-in, check-out, adjusted, effects, review), with the work location name, distance and accuracy, and the note "Coordinates are never shown." The Corrections tab lists requests with status. The "Request a correction" dialog has five reasons, corrected times (next day for overnight check-outs) and details, and goes through the request workflow.
- **Team attendance (`/attendance/team`, `attendance.team`).** Day tab: everyone in scope on one date with a derived status (future days are never absent), department filter and a card layout on mobile. Records tab: a range filter (at most 62 days) with "Load more", and CSV export for that range (a hint replaces the export link when the range is too long). Review queue: low-accuracy check-ins with Accept and Reject; rejecting needs a note. HR (`attendance.admin`) additionally sees "Correct" (fresh MFA, reason and note) and device details. No salary or payroll data appears anywhere.
- **Configuration (`/admin/attendance`, `/admin/work-locations`).** The policy form (read-only without `org.settings.manage`), shifts (new or edit dialog: start, end, overnight hint, grace minutes, weekdays) and assignments (employee picker, shift, start and optional end, end-assignment dialog, "Load more").
- **Accessibility and RTL.** All attendance screens are translated (English, Arabic) and mirror in RTL with times and numbers left-to-right. Tabs follow the ARIA pattern; arrow keys are mirrored in RTL. Statuses use text as well as color.
- **Testing.** `apps/e2e/tests/12-attendance.spec.ts` covers the 22 Phase 7 flows with mocked geolocation. It runs axe with horizontal-overflow checks on Today, the correction dialog, history, corrections, team day, records, the review queue, configuration, work locations and the shift dialogs at 375, 768, 1024 and 1440 px, and repeats Today and team attendance in Arabic (RTL).

Phase 10 tenders and contracts (as built, ADR-0026):

- **Tenders (`/tenders`).** Server-side search with status, deadline and readiness filters and "Load more"; rows on wide screens and cards on phones with key, title, deadline in the tender's zone, status chip with text and readiness. Money appears only for `tender.financial.view`. Dashboard links open the list with their filters and a "Clear filter" notice.
- **Tender detail (`/tenders/[id]`).** Header with key, status, deadline in the tender's zone, readiness and only the actions the viewer may take. Tabs with deep links (`#overview`, `#requirements`, `#reviews`, `#documents`, `#submission`, `#addenda`, `#guarantees`, `#timeline`): the compliance matrix with owner, reviewer, due date, status actions and document links; review rounds per gate; documents with categories, classification and versions; submission with evidence, award and loss; addenda that keep the previous deadline, and clarifications; guarantees; the business timeline. Gated steps are dialogs with explicit confirmation. Involved members see "You can see this record because you own work on it." and no money.
- **My Tender Work (`/tenders/my-work`).** The requirements a member owns or reviews and the review decisions waiting for them, each linking to its tender; requirement managers can switch the view to unassigned, overdue, blocked or critical requirements.
- **Contracts (`/contracts`).** Search with status and health filters, cards on phones; current value only with `contract.financial.view`.
- **Contract detail (`/contracts/[id]`).** Header with key, status, health with its reasons, current expiry and notice deadline, source tender and project links. Tabs: overview (original and current value side by side), obligations (occurrences with due state, completion with evidence, waive), milestones, amendments (draft, submit, approve, activate), renewal (decision and actions with notice deadline), documents, guarantees (Expiring with days left) and timeline.
- **Documents (`/documents`).** The Corporate Document Vault: validity badges (valid, expiring, expired, no expiry, no file), versions with upload, and "Used by" requirement links. A document opens in a dialog; `/documents?open=<id>` deep-links to it (search, Needs Attention and notifications use this).
- **Commercial dashboard (`/dashboards/commercial`), executive cards, project Commercial tab and `/admin/commercial`** (reminder thresholds, read-only without `org.settings.manage`).
- **Accessibility and RTL.** Every commercial screen is translated (English, Arabic) and mirrors in RTL; keys, dates and money stay left to right (`dir="ltr"`), money is shown as "480,000 EGP" and never mixes currencies. Statuses and health use text as well as color.
- **Testing.** `apps/e2e/tests/15-commercial.spec.ts` covers the 41 Phase 10 scenarios, runs axe with horizontal-overflow checks on the commercial screens and a dialog at 375 and 1440 px, checks the tender and contract screens at 375 px for the general manager and My Tender Work for an employee, and repeats the lists, detail screens and dashboard in Arabic (RTL).

## 5. Loading, empty and error states

Every data region implements all four states; there are no blank screens.

| State | Pattern |
|---|---|
| Loading | Skeletons matching final layout (no spinners for page loads > 300 ms); buttons show inline progress and are disabled while submitting |
| Empty | Plain-language explanation + the next action the user is permitted to take (e.g. "No projects yet — Create project"); for modules not yet configured, a link to the relevant setup step; never sample/fake data |
| Error | Message from the translated `error.code`, a retry action, and the `requestId` in a copyable "details" disclosure. Field validation errors inline, mapped from `fieldErrors`, plus an error summary at the top of long forms |
| Partial / stale | Integration data shows "as of <time>" and a non-blocking warning when the connection needs attention |
| Permission | 403 → "You don't have access" page with a way back; 404 → generic not found (also used for foreign-tenant IDs) |
| MFA required | Interstitial explaining the extra verification, then redirect to step-up and back to the original action |
| Offline (PWA) | Offline fallback page; forms keep unsent input and show "You're offline — try again when connected" (no offline sync in V1) |

## 6. Responsive rules

- Verified viewports: **375, 768, 1024, 1440 px** (Playwright projects).
- Tables with more than 4 columns render as **card lists below 768 px**; the same filters/sort apply.
- Forms: single column on mobile; two columns allowed ≥ 1024 px for short fields only.
- Touch targets ≥ 44 × 44 CSS px; spacing between targets ≥ 8 px.
- No horizontal scrolling of the page; wide tables scroll inside their container with sticky first column on tablet+.
- Dialogs become full-screen sheets on mobile.
- Images (attachments) use responsive sizes; never auto-load originals on mobile.

## 7. Accessibility (WCAG 2.2 AA-oriented)

- Semantic HTML first; Radix primitives for interactive widgets (focus management, ARIA).
- Visible focus indicator on every interactive element; logical tab order; skip-to-content link.
- Color contrast ≥ 4.5:1 for text, ≥ 3:1 for UI components; status never conveyed by color alone (icon + text on severity/SLA chips).
- All form inputs have labels; errors announced via `aria-live` and linked with `aria-describedby`.
- Respect `prefers-reduced-motion`; no auto-playing motion.
- Charts have a text/table alternative.
- Automated axe checks (`@axe-core/playwright`) on every E2E page; manual keyboard and screen-reader pass in Phase 9.

## 8. Internationalization — English first, Arabic/RTL ready

- All UI strings from `packages/i18n` catalogs via `next-intl`; no hard-coded strings (lint + review).
- Locale stored per user (fallback: org default). English complete in every phase; Arabic catalog skeleton from Phase 1, full translation before Arabic rollout.
- `<html lang dir>` set per locale; Arabic renders `dir="rtl"`.
- Layout uses **logical properties only** (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`); directional icons (arrows, chevrons) mirror in RTL; numbers, dates and times formatted with `Intl` in the user's locale and the **org's configured time zone**.
- Text expansion: components tolerate +40% string length; no fixed-width labels.
- Error messages keyed by `error.code`; the API's English `message` is a fallback only.

## 9. Visual system

- shadcn/ui-generated components owned in `packages/ui`, Tailwind 4 tokens (color, radius, spacing, typography) with light and dark themes.
- One icon family (lucide-react).
- Severity/priority/SLA/status chips share one component with consistent semantics across modules.
- Toasts (sonner) only for confirmations of user-initiated actions; errors that need action are shown inline.
