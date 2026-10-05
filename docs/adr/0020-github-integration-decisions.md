# ADR-0020: GitHub integration decisions (Phase 5)

Date: 2026-10-03 · Status: Accepted

## Context
Phase 5 delivers the GitHub integration (ROADMAP P5-1…P5-7): a GitHub App per deployment, installation setup and binding, repository discovery and project mappings, a pull-request metadata cache with review and check summaries, verified webhooks, initial sync and reconciliation, Jira key inference and manual links, the project GitHub tab, the ticket pull-request panel, and the administration screen. It also closes the Phase 4 carry-forward on retention of technical integration records. `INTEGRATIONS.md` §2.1–2.5 (Phase 0 strategy), `DATA_MODEL.md` and `SECURITY.md` described the design before GitHub's current documentation was re-read. Every GitHub contract used was re-checked against docs.github.com on 2026-10-03 (`INTEGRATIONS.md` §2.6.1). No GitHub App, test organization or credentials were available, so the integration is verified against a deterministic test double only. Decisions follow the priority order repository documents → earlier ADRs → master specification → existing implementation → current official GitHub documentation → safest production practice.

## Decision

### App model and permissions
- **One GitHub App per deployment**, registered by the operator from `infra/github/app-manifest.template.json`. Permissions: Metadata, Pull requests, Checks and Commit statuses **read**; **Contents none** (no source, diffs, file lists or commit history are fetched or stored). Subscribed events: `repository`, `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `status`; GitHub always sends `installation` and `installation_repositories` to Apps, so they are not listed in the manifest. Every other event is acknowledged and ignored.
- Personal access tokens, shared developer tokens, organization-owner tokens and long-lived installation tokens are not supported anywhere.
- Secrets come from the deployment environment or `*_FILE` mounts only: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`. The API needs all six App values (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` plus the three secrets); the worker needs ID, client ID and private key only. Leaving `GITHUB_APP_ID` empty disables the integration (the webhook route answers `404`). Base URLs are overridable only for the test double and must be GitHub.com's in production (enforced by env validation).

### Installation setup and binding (previous design: signed state + App JWT lookup)
- **Previous design** (INTEGRATIONS §2.2): a signed `state` plus `GET /app/installations/{id}` with the App JWT. **Change:** GitHub's documentation ("About the setup URL") warns that `installation_id` can be spoofed and that the installation must be checked against a user access token of the installing user. A valid state alone would let an administrator bind *any* installation of the App whose id they know. **Decision:** the setup URL only re-issues the state with the installation id and sends the browser through GitHub user authorization; the callback exchanges the code for a short-lived user token, requires the installation to appear in `GET /user/installations`, **revokes the user token**, re-reads the installation with the App JWT, and binds it.
- The state is random, stored hashed in Redis for 10 minutes, single use, and bound to organization, member, user and a one-way hash of the server-side session id. Every setup route needs `integration.manage` at organization scope with fresh MFA, and is rate limited. Outcomes are redirects to the admin page with a short reason code; no token ever reaches the browser.
- `github_installations.github_installation_id` is **globally unique**: an installation is bound to exactly one organization. Binding one already bound elsewhere is refused (`GITHUB_INSTALLATION_CONFLICT`). Binding, refresh, suspension, deletion and disconnect are audited.
- Installation states `ACTIVE`, `SUSPENDED`, `DELETED` (uninstalled on GitHub), `DISCONNECTED` (unbound here; the App stays installed on GitHub). Suspension pauses all GitHub calls for that installation; suspension and deletion notify integration administrators (deduplicated per installation version).

### Tokens (previous design: Redis cache for a fixed 50 minutes)
- App JWT: RS256, `iat` backdated 60 s, lifetime 540 s, issuer = client ID; signed in memory and re-signed 60 s before expiry.
- Installation tokens are created server-side only, never persisted in the database, never returned, never logged. **Change:** instead of a fixed 50-minute cache, tokens are kept until 5 minutes before the `expires_at` GitHub returned, with no assumption about token length or format. They are cached in memory and, AES-256-GCM-encrypted with the deployment key, in Redis so API and worker share them. Creation runs under a per-installation Redis lock with a re-check, so concurrent callers share one token. A `401` renews the token once.

### Webhooks (previous design: `@octokit/webhooks` `verify`)
- `POST /api/v1/webhooks/github` reads the **raw body** with a byte cap (`GITHUB_WEBHOOK_MAX_BYTES`, default 5 MiB; declared and streamed oversize bodies get `413`) before any parsing, whatever the content type. **Change:** the HMAC-SHA256 check uses Node's `crypto` (`createHmac` + `timingSafeEqual` on equal-length digests) instead of `@octokit/webhooks`, avoiding a new dependency; it is tested against GitHub's published test vector. Only `X-Hub-Signature-256` is accepted; the legacy SHA-1 `X-Hub-Signature` is never read. The route is public, CSRF-exempt and IP rate limited.
- Order: verify signature → validate headers and payload shape → persist the delivery → enqueue through the outbox → `202`. A duplicate `X-GitHub-Delivery` (globally unique) answers `200` without queuing; a manual redelivery of a delivery whose processing failed is re-queued. Unknown installations and unsupported events are acknowledged and not stored.
- The tenant is taken **only** from the persisted installation binding. Only identifiers are stored (delivery id, event, action, repository id, PR number, head SHA); payloads and headers are not. The worker re-fetches the installation, repository, pull request, reviews and checks from GitHub, so a payload can never write pull-request data.

### Processing, ordering and rate limits
- Pull requests upsert by `(organization, repository, github_pr_id)` and ignore an older `updated_at`. Review/check summaries record the head SHA and the time their fetch *started*; a write lands only if that fetch is newer than the stored one and the head has not moved, so slow or reordered refreshes never overwrite newer data.
- **Coalescing:** a check, status or review delivery skips the details refresh when the stored summary for the same head was fetched at least 5 s after the delivery arrived (outcome `checks_current`). A backlog after a pause or outage then costs one refresh per pull request instead of one per delivery. Larger clock skew between API and worker is corrected by reconciliation.
- A primary or secondary rate limit pauses every call for that installation until the reset (Redis); idempotent calls retry with jittered exponential backoff; per-record failures go to append-only `github_sync_failures` and the run ends `PARTIALLY_FAILED`.
- Repositories are keyed by GitHub's immutable id: renames update the row, transfers out of the installation or lost access mark it `REMOVED`/`DELETED` (`unavailable_at`), history and mappings stay, and nothing is ever remapped to another repository.

### Sync engine
- Runs `INITIAL_SYNC`, `RECONCILIATION` and `MANUAL_RESYNC` execute as bounded slices that re-enqueue themselves, with one active run per repository (partial unique index). Initial sync imports open pull requests plus pull requests closed within `GITHUB_PR_HISTORY_DAYS` (default 90). Reconciliation (default every 30 minutes) reads pull requests updated since the last run with a 10-minute overlap; installation repository discovery runs every 6 hours by default. A watchdog re-enqueues runs without progress for 10 minutes.
- Page rendering never calls GitHub: the project tab, ticket panel and admin screen read the local cache only.

### Jira association
- Keys are inferred from the branch name (any case), title and the first 10 000 characters of the body (upper case), at most 50 per pull request. Keys whose prefix is not a mapped Jira project key of the organization are dropped.
- A key becomes a link only when the issue exists in the **Jira cache**: `CONFIRMED` automatically when the issue's Jira project maps to a project the repository is also mapped to, `SUGGESTED` otherwise. Keys without a cached issue remain unverified suggestions on the pull request; no issue is ever invented. `DISMISSED` links are never recreated.
- Manual linking, confirming and dismissing need `github.link` on the project and may only use cached issues of Jira projects mapped to that project; each action is audited.

### Visibility
- The project GitHub tab needs `github.view` on the project; the ticket panel needs `github.view` on the ticket (others get `visible:false`), and linking needs `github.link` on an unlocked ticket. Both only ever show pull requests from repositories mapped to that project. Signals are operational only (`DRAFT`, `AWAITING_REVIEW`, `CHANGES_REQUESTED`, `FAILING_CHECKS`, `STALE_SYNC`); there are no per-developer metrics or rankings.

### Retention of technical records (closes the Phase 4 carry-forward)
- New `retention_policies` table (per organization and category, `retain_days` 7–3650, optimistic version), managed with `org.settings.manage` + MFA and audited. **Without a policy nothing is purged.**
- The worker calls the `SECURITY DEFINER` function `purge_integration_records(org, category, limit)` daily in bounded batches. It deletes only processed Jira/GitHub webhook deliveries (`WEBHOOK_DELIVERIES`) or Jira/GitHub sync failures (`SYNC_FAILURES`) older than the policy. Sync-failure tables stay append-only for the application role; the trigger allows deletes only inside the function. Audit history, Support↔Jira links, ticket↔PR links, PR↔Jira links, caches and runs are outside its reach. The runtime role holds no `DELETE` on any GitHub table except direct ticket↔PR links and retention policies.

### Data integrity
- Every GitHub table carries `organization_id` with composite `(organization_id, id)` foreign keys, so cross-tenant references are rejected by the database. Checks constrain lengths, counters and state/timestamp consistency.

### Testing
- `FakeGithub` (`packages/core/src/testing/fake-github.ts`) is a deterministic in-process HTTP server implementing the documented contracts used (App JWT verification, installation tokens, user authorization and `/user/installations`, repositories, pulls, reviews, check runs, combined status, rate-limit and failure injection, HMAC-signed webhook emission, suspension, removal and renames). Unit, integration (core, API, worker) and Playwright suites run against it.

## Consequences
- The integration is implemented against documented contracts but **unverified against a live GitHub App**; DEPLOYMENT §6 ("Live GitHub verification checklist") lists the checks to run against a test organization before production use.
- Setup requires the installing administrator to authorize the App as a GitHub user once per installation; the user token is revoked immediately.
- Webhooks need an `https` public URL. Without them, data is still correct within the reconciliation interval.
- Removing a mapping or disconnecting keeps history; removed repositories remain visible as unavailable.
- The pull-request cache holds a fixed field set; new fields require a re-sync after deployment.
