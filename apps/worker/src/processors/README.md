# Processors

One directory per queue (`src/processors/<queue>/`), added by the phase that owns the queue
(`docs/ARCHITECTURE.md` §3). Phase 1 ships `notifications/` (outbox `notification.requested`
events) and `maintenance/` (expiry of abandoned upload intents). Phase 2 adds `projects/` (outbox
`project.activity.recorded` events → project timeline) and `reports/` (scheduled
`daily-report.missing.check`). Phase 3 adds `sla/` (scheduled SLA sweep). Phase 4 adds `jira/`
(queue `jira-sync`: sync-run slices that re-delay themselves, webhook processing, webhook
registration/refresh, connection cleanup, plus the reconciliation and stale-run schedule).
Job handlers are plain functions
so they can be tested without a running worker; the `*.processor.ts` files only adapt them to BullMQ.
