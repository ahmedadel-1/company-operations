# ADR-0023: Dashboards, Needs Attention, global search, setup checklist and notification preferences (Phase 8)

Date: 2026-10-04 · Status: Accepted

## Context
Phase 8 (ROADMAP P8-1…P8-8) adds the operational home: role dashboards, a rule-based Needs Attention feed, trend charts, Redis caching with event invalidation, PostgreSQL global search, the first-run setup checklist and notification preferences. `UI_UX.md` §3, `ARCHITECTURE.md` (API inventory, caching), `DATA_MODEL.md` §10 and `PRD.md` §7.5 hold the Phase 0 design. The product question is "what requires attention right now?" — not a chart gallery, BI warehouse, surveillance tool or ranking system. Decisions follow repository documents → earlier ADRs → master specification → existing implementation → safest practice.

## Decision

### Read services, not controllers
- All aggregation lives in `packages/core/src/modules/dashboard/` (read-only services). Controllers only validate and delegate; React only renders. Dashboard services never write business rows.
- **Counts reuse the list filters they link to.** Each list service exposes its `where` builder (`ticketListWhere`, `projectListWhere`, `approvalInboxWhere`, request list scope, attendance day buckets) and the dashboard counts call the same builder with the same filter object that the deep link encodes. A count and its linked list therefore cannot disagree except for changes between the two requests. Integration tests assert count = linked list length for every linked metric.
- Every metric is returned as `{ key, value, link }` where `link` is a **filter descriptor** (`{ path, query, hash }`) the web turns into a URL (P8-1). The list pages read those query parameters through the router (never `window.location` during render) and start from them.
- Queries are grouped (`groupBy`, `count`) on existing composite indexes; no per-row or per-project query loops (missing daily reports are derived for all projects in scope with three queries).

### Dashboards and authorization
| Endpoint | Gate (route) | Scope used for data |
|---|---|---|
| `GET /dashboard/me` | signed-in member | own records only (attendance today, own requests, approvals assigned to me, tickets reported by / assigned to me, own projects, own daily report due) |
| `GET /dashboard/team` | `attendance.team` | `attendance.team` list scope (TEAM / DEPARTMENT / PROJECT / ORG) |
| `GET /dashboard/support` | `support.view` held beyond SELF | `support.view` list scope (same as the ticket queue) |
| `GET /dashboard/projects` | `dashboard.project` | `project.view` list scope ∩ the projects `dashboard.project` reaches; Jira/GitHub signals only for projects in `jira.view` / `github.view` scope |
| `GET /dashboard/executive` | `dashboard.executive` | the same section builders with the caller's scopes (ORG for GM/TM baseline) |
| `GET /dashboard/needs-attention` | signed-in member | per rule (below) |
| `GET /dashboard/trends` | metric-specific (`support.view` beyond SELF, `attendance.team`) | same scopes as the section |

The HR dashboard is the team dashboard with HR's ORG `attendance.team` scope plus the attendance review queue; the technical dashboard is the projects dashboard with development signals emphasized (TM holds ORG `dashboard.project`). Hidden cards are never the security boundary: every endpoint re-checks the permission and every number is computed from the caller's server-resolved scope.

**No per-person metrics.** No agent, developer or employee ranking, leaderboard or per-person count appears anywhere (support queues have "assigned to me", never "per agent"; Jira/GitHub signals are per project).

### Metric definitions
Definitions (source, scope, time semantics, inclusion) are listed in `ARCHITECTURE.md` §11e and in the response contracts. "Today" is the organization's local date (`organizations.time_zone`); attendance uses each employee's own zone for their work date exactly as Phase 7 does. Snapshot metrics (open, at risk) are current state; period metrics (resolved today, trend buckets) are local-date buckets computed from stored timestamps.

### Needs Attention
- A deterministic, rule-based feed (no AI, no identity-based priority). Each item has a stable `type`, `severity` (CRITICAL / HIGH / MEDIUM / LOW), i18n params, source entity, `occurredAt`, a deep link and the scope it came from.
- Rules: SLA breached ticket (CRITICAL when the ticket is CRITICAL, else HIGH), critical ticket unassigned (CRITICAL), SLA at risk (HIGH), project health CRITICAL (CRITICAL) / AT_RISK (HIGH), approval overdue (HIGH) / waiting (MEDIUM), own missing check-out (MEDIUM), attendance reviews waiting (MEDIUM), own daily report due (MEDIUM), requests awaiting fulfillment (MEDIUM), Jira/GitHub integration problem (HIGH, admins only).
- Order: severity rank, then `occurredAt` ascending (waiting longest first), then the stable item key. **Deduplication** by source entity: one entity yields one item, the highest-severity rule wins (a breached critical ticket is not also listed as at-risk or unassigned). Capped at 50 items; the response says when more exist.

### Caching (P8-4)
- Redis keys: `dash:v1:{organizationId}:{dashboard}:{scopeHash}:{versionsHash}`. `scopeHash` is a SHA-256 of the exact list scopes (permission → ORG flag + member/department/project id sets) the dashboard reads, plus the member id for personal sections. Two members share an entry only when their effective scopes are identical. A role or hierarchy change changes the scope hash on the next request, so a narrower principal can never be served a broader principal's entry.
- Authorization is never cached: the permission check runs on every request before the cache is read; only the computed numbers are cached.
- **Targeted invalidation**: per-organization domain counters `dash:ver:{organizationId}:{domain}` (support, projects, requests, attendance, jira, github). Each cache key embeds the counters of the domains it reads; the worker increments a counter when an outbox event of that domain is processed (ticket change, request change or effect, project activity, attendance change, Jira/GitHub sync). No global flush. TTL 60 s is the fallback for anything not evented.
- **Redis failure**: reads and writes are best-effort; any Redis error falls back to the source queries (logged, never surfaced). The cache is never authoritative.

### Trends (P8-5)
Only series backed by stored history: support tickets created vs resolved per day, and attendance check-ins per day. Ranges: today, 7, 30, 90 days (no free ranges), local-date buckets in the organization zone, zero-filled. Rows are bounded (20 000 per series); a truncated series says so. "Resolved" uses the current `resolved_at` (a reopened ticket leaves the series), documented in the chart text.

### Global search (P8-6)
- PostgreSQL only. Entities: projects (`project.view` scope), employees (`employee.view` scope), support tickets (`support.view` scope incl. own reported), requests (own, plus `request.view` scope), Jira issues (cached issues of projects in `jira.view` scope). GitHub pull requests are not part of the roadmap's search scope and are not searched.
- Authorization is applied in the SQL `where` (the same scope builders as the lists), before any row leaves the database.
- Matching: case-insensitive substring (`ILIKE` with escaped `%`/`_`) on names, codes, titles, employee numbers and Jira keys/summaries, backed by **pg_trgm GIN indexes**; exact keys (`SUP-12`, `REQ-7`, `ABC-123`, `EMP-00012`) are matched first. **Deviation from "tsvector + pg_trgm"**: searched fields are short names, codes and titles in mixed Arabic/English; trigram matching covers word and partial matches in both scripts without a language-specific dictionary, so no `tsvector` column was added. Employee email is matched only for callers holding `employee.view_contact` at ORG scope.
- Bounds: query normalized (NFKC, trimmed, whitespace collapsed), 2–100 characters, at most 5 entity types, per-type limit ≤ 10, "more" pagination within one type up to 50 results; a per-user rate limit (`RATE_LIMIT_SEARCH_PER_MINUTE`, default 60; the palette debounces typing by 250 ms, so one lookup costs a few requests). Ranking is deterministic: exact key → prefix → word start → substring, then label, then id.

### Setup checklist (P8-7)
Derived on every request from real state (organization exists, departments, invited employees, work locations, attendance policy, request types published, SLA policy, projects, Jira connection, GitHub installation); nothing is stored. `organizations.setup_state` stays unused (no flags were ever written); the ROADMAP note "flags exist since Phase 1" is superseded. Admins only (`org.settings.manage` at ORG); each item links to its admin screen. Jira and GitHub are optional items.

### Notification preferences (P8-8)
- `notification_preferences (organization_id, member_id, category, channel, enabled)`; channels IN_APP and EMAIL only (no Teams/Slack/Push). Categories are derived from the notification type (`notificationCategory`): ACCESS, PROJECTS, DAILY_REPORTS, SUPPORT, REQUESTS, ATTENDANCE, INTEGRATIONS.
- Locked (cannot be disabled): ACCESS on both channels (security), INTEGRATIONS in-app (admin alerts), and every notification with severity CRITICAL on every channel.
- Muting IN_APP stores the notification as already read (history stays complete, no badge, no live hint); muting EMAIL skips the delivery row. The email worker re-checks the preference and the recipient's status at send time and marks the delivery SKIPPED. A member can only read and change their own preferences; preferences never widen who receives what.

### Phase 7 low-accuracy wording
"Submit anyway" became "Send this reading", described by text stating that the server still applies the organization policy (refused or recorded for review) and that a low-accuracy reading never counts as inside a work location. Geofencing is unchanged.

### Findings fixed during Phase 8
- **Organization-wide `request.view` saw no requests** (Phase 6 defect). Inside the tenant-scoped client, Prisma matches nothing for an empty object in an `OR` array, and `requestScopeWhere` added `{}` for ORG scope. HR, the GM and administrators therefore got empty "all requests" lists and could not find requests by key. Organization scope now builds no `OR` branch at all (only "not someone else's draft"); regression tests cover the list and search for HR, the GM and the administrator. Rule kept for all later code: never push `{}` into an `OR`.
- **Dashboard links opened unfiltered lists after client-side navigation.** The list screens read the link's query from `window.location` during their first render; a Next.js client navigation commits the new URL only after that render, so the filters of the previous page (none) were used. The screens now receive the query from `useSearchParams` through `WithLinkParams` (inside a `Suspense` boundary, keyed by the query so a new link remounts the list), and the team attendance tab follows the hash through `useSyncExternalStore`. Found by the Playwright count = list checks (E2E 8, 9).
- **A check-in after the day's missing-checkout deadline could not be checked out** (Phase 7 defect, found by the final gate when the API attendance test ran at 21:20 Cairo time). Check-in falls back to the local date, but check-out only accepted records whose deadline (scheduled end + grace) had not passed, so the late record was immediately "missing its check-out" and the today screen offered a check-out that failed. `missingCheckoutDeadline` now starts the grace from the later of the scheduled end and the check-in; check-out and the sweep share it. Regression: engine unit test and `attendance.security.int.test.ts` (late check-in, sweep leaves it open, check-out succeeds, no missing-checkout event) with a fixed clock.
- Search rate limiting counts refused (`400`) queries as well, so validation errors cannot be used to probe without cost; the default of 60 per user and minute is enough for the debounced palette.

### Deviations
- No `tsvector` columns (trigram matching, above).
- No `GET /dashboard/project/:id`, `/dashboard/technical` or `/dashboard/hr` routes from the Phase 0 inventory: the project screen is the per-project view, and the technical and HR views are the projects and team dashboards with those roles' scopes.
- `organizations.setup_state` is not used (derived checklist).
- Preferences are per category, not per notification type; CRITICAL notifications cannot be muted and this is enforced in code (the service and the email worker), not by a stored row.

## Consequences
- Dashboards add no tables; the only new table is `notification_preferences`, plus trigram indexes for search.
- Count/list consistency is structural, not coincidental, and covered by tests.
- Cache hit rates are per scope; personal sections (`/dashboard/me`) are not cached because they are cheap, indexed, member-bound queries.
