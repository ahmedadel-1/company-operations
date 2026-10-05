# ADR-0019: Jira Cloud integration decisions (Phase 4)

Date: 2026-10-03 · Status: Accepted

## Context
Phase 4 delivers the Jira Cloud integration (ROADMAP P4-0…P4-10): the OAuth 2.0 (3LO) connection, project mappings, the issue cache, historical import, dynamic webhooks, reconciliation, support ticket ↔ Jira links, issue creation from tickets, status signals and the project Jira tab. `INTEGRATIONS.md` §1.1–1.8 (Phase 0 strategy), `DATA_MODEL.md` §8 and `SECURITY.md` §7/§10 left details open or assumed Atlassian behaviour that had to be re-verified. Every Atlassian contract was re-read from the official documentation on 2026-10-03 (`INTEGRATIONS.md` §1.9.1). No live Jira Cloud site was available, so the integration is verified against a deterministic test double only. Decisions follow the priority order repository documents → earlier ADRs → master specification → existing implementation → current official Atlassian documentation.

## Decision

### Connection model
- **One live connection per organization**, unique `(organization_id, cloud_id)` plus a partial unique index on non-disconnected rows. Reconnecting the same site updates the existing row, so mappings, cached issues and links resume; connecting a different site requires disconnecting first.
- **States** `ACTIVE`, `NEEDS_REAUTH`, `ERROR`, `DISCONNECTED`. `NEEDS_REAUTH` is set once (with a notification to integration administrators) on `invalid_grant`, revocation or undecryptable tokens; sync pauses without retries. Disconnect stops sync and cancels runs synchronously; webhook deletion and token wiping happen in `jira.connection.cleanup`, which only removes registrations created before the disconnect (a racing reconnect keeps its new webhook). Cache and links are kept for history.
- All connection, mapping and run administration needs `integration.manage` at organization scope, a privileged permission (fresh MFA).

### OAuth and tokens
- Scopes `read:jira-work write:jira-work manage:jira-webhook offline_access`. **`read:jira-user` is not requested** (deviation from INTEGRATIONS §1.2): assignee and reporter display names come with issue search and fetch, and no user endpoint is called.
- The `state` is random, stored hashed in Redis for 10 minutes, single use and bound to organization, member and user. With several accessible sites the token set is parked under a 10-minute single-use grant until the administrator chooses one. Site URL and cloudId come only from `accessible-resources`; only `https` site URLs are accepted.
- Tokens are AES-256-GCM envelopes with AAD `organization|connection|field`, decrypted only in the backend. Refresh runs under a per-connection lock, re-reads the row, and stores the rotated refresh token with the new access token in one versioned update. A `401` gets exactly one forced refresh.

### Webhooks
- **One dynamic webhook per connection**, `project in (<mapped numeric ids>)`, issue created/updated/deleted. A changed project set registers the new webhook before deleting the old one; registrations are refreshed when fewer than 7 of their 30 days remain.
- **Verification model:** HS256 JWT signed with the app's client secret (the documented OAuth 2.0 app model), constant-time comparison, `HS256` only, `exp`/`nbf` with 60 s leeway when present. Because the secret is per app, the delivery is also bound to the connection in its path (unknown or disconnected → `404`) and to that connection's registered webhook ids when `matchedWebhookIds` is present (`403`).
- **Dedupe:** `X-Atlassian-Webhook-Identifier` (else a hash of event, issue and timestamp), unique per connection. Only identifiers are stored. Processing re-fetches the issue with the connection's own token, so payload fields are never trusted.

### Sync engine
- Runs (`INITIAL_IMPORT`, `RECONCILIATION`, `DEEP_RECONCILIATION`, `MANUAL_RESYNC`) execute as **bounded slices** of up to 100 issues that re-enqueue themselves; one active run per mapping (partial unique index), one slice per connection at a time (Redis lock).
- The durable checkpoint is a timestamp plus the last row id with an overlap (2 minutes import, 10 minutes reconciliation); `nextPageToken` is only an optimization. Upserts are keyed by `(connection_id, jira_issue_id)` and ignore older `updated` values, so overlaps, replays and out-of-order webhooks are harmless.
- Reconciliation hourly and deep reconciliation weekly by default (`JIRA_RECONCILE_INTERVAL_MS`, `JIRA_DEEP_RECONCILE_INTERVAL_MS`); a watchdog re-enqueues runs without progress for 10 minutes. Deep reconciliation tombstones issues Jira no longer returns and queues a full re-sync when the approximate count drifts by more than 1 %.
- A `429` (or `503` with `Retry-After`) pauses all calls of the connection; idempotent calls retry with jittered exponential backoff; per-issue failures go to append-only `jira_sync_failures` and the run ends `PARTIALLY_FAILED`.

### Support links and issue creation
- Endpoints live under the ticket (`/support/tickets/:id/jira`, `/jira/search`, `/jira/links`, `/jira/issue-types`, `/jira/issues`) instead of `/jira-links` and `/jira-issues` (INTEGRATIONS §1.6 naming).
- Permissions: viewing the panel needs `jira.view` on the ticket (others get `visible:false` and do not see Jira history events); linking needs `jira.link`, creating needs `jira.create_issue`, both on an unlocked ticket. Only issues of Jira projects mapped to the ticket's project can be linked or created.
- **Issue creation idempotency uses a database reservation** (`jira_issue_create_requests`, unique per ticket and `Idempotency-Key`) instead of the Redis `ticketId + hash(summary)` guard of INTEGRATIONS §1.6: same key and body returns the original result, a different body is `409`. `POST /issue` is never retried automatically; an attempt interrupted for more than 2 minutes becomes `UNKNOWN` and the user is asked to check Jira first.
- The issue description is exactly the text the user confirmed (prefilled from the public description) plus a back-link. Internal notes, comments and attachments are never sent.
- Linking, unlinking, creating and status changes in Jira **never change the ticket status**. A status-category change of a linked issue appends `JIRA_STATUS_SYNCED` and notifies the assignee and watchers.

### Signals
- Blocked = status name in the mapping's configured list (case-insensitive) or, with an empty list, a name containing "block". The `Flagged` field and issue links are not read (narrower than INTEGRATIONS §1.8, avoids custom-field discovery). Overdue = due date before today in the organization's time zone and not DONE. No per-developer metrics.

### Abuse protection
- A per-user `jira` rate-limit bucket (`RATE_LIMIT_JIRA_PER_MINUTE`, default 30) covers every route that calls Jira or queues Jira work, so one user cannot exhaust the organization's shared Jira quota (extends ADR-0016).

### Testing
- A deterministic in-process HTTP double (`FakeJira`) implements the documented contracts, including OAuth rotation, revocation, page tokens, HS256-signed webhook deliveries and injected 429/5xx/timeouts. It replaces `undici` `MockAgent` (INTEGRATIONS §5) so the same double serves unit, integration and Playwright tests over real HTTP. The Atlassian base URLs are configurable only for this double and must be Atlassian's in production. <!-- gitleaks:allow -->

## Consequences
- The integration is implemented against documented contracts but **unverified against a live Jira Cloud site**; DEPLOYMENT §6 lists the checks to run against a non-production site before production use.
- Webhooks only work behind an `https` public URL, and for a non-distributed Atlassian app only when the connecting administrator owns the app. Without them, data is still correct within the reconciliation interval.
- `jira_webhook_deliveries` and `jira_sync_failures` grow without pruning (the application role cannot delete them); a retention job is follow-up work.
- The cache holds a fixed field set; new fields need a full re-sync after deployment.
