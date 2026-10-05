# ADR-0011: Phase boundary adjustments

Date: 2026-10-02 · Status: Accepted

## Context
The master spec's phase plan does not phase some cross-cutting capabilities (notifications, global search, first-run checklist, real-time) and warns against over-expanding Phase 1.

## Decision
| Capability | Spec placement | Placement chosen | Reason |
|---|---|---|---|
| Transactional outbox + relay | not specified | **Phase 1 (foundation)** | Every later module emits events; must exist before them |
| Notification **foundation** (persistence, dedupe key, in-app list/read API, minimal bell UI) | §19, unphased | **Phase 1 (foundation only)** | SLA (Phase 3) and approvals (Phase 6) depend on a delivery mechanism |
| Email channel (SMTP abstraction, templates) | §19 | **Phase 3** | First consumer is SLA/escalation |
| Real-time (SSE + Redis pub/sub) | §31 | **Phase 3** | First material use: critical incidents/assignments; Jira import progress (Phase 4) reuses it |
| Notification preferences UI | §19 "eventually" | **Phase 8** | Product feature, not foundation |
| Global search | §22, unphased | **Phase 8** | Spans all modules; data exists only after Phases 2–7 |
| First-run setup checklist | §43, unphased | **Phase 8** (data flags exist from Phase 1 in `organizations.setup_state`) | Steps span Jira/GitHub/requests/SLA |

Jira (4), GitHub (5), Requests (6), Attendance (7) and Management Dashboard (8) remain where the spec placed them.

## Consequences
- Phase 1 stays a foundation phase; product features are not pulled forward.
- `ROADMAP.md` reflects these placements.
