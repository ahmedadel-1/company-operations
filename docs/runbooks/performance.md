# Runbook: performance, capacity and rate limits

All numbers come from the Phase 9 rehearsal of the production stack (release images,
`docker-compose.prod.yml`, one container per service). Host: Docker Desktop on WSL2, Intel i7-12700H
(20 threads), 8 GB for Docker. Load was generated inside the Docker network against the API container
(`scripts/release/load.ts`) with an authenticated organization-administrator session, so it measures
the application rather than TLS or the network. Rate limits were raised for the load runs only, then
restored. Treat the numbers as a lower bound for a dedicated 4-vCPU server; repeat them on the target
hardware before go-live.

## Targets (PRD)

- p95 < 300 ms for list and detail endpoints at enterprise scale (≤ 5,000 employees and
  ≤ 500,000 Jira issues per organization).
- All lists paginated.

## Load test

Read mix per worker, round robin over 12 endpoints:

- `me`
- personal dashboard
- needs-attention
- unread count
- notifications
- employees, support queue, customers (50 per page)
- approvals summary
- attendance today
- search
- audit events

Write phase: 300 employees, 300 customers and 300 support tickets created concurrently (full write
path: validation, audit, outbox, numbering).

| Phase | Concurrency | Requests | Throughput | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|---|
| Writes | 8 writers | 900 | 167/s | 15 ms | 213 ms | 408 ms | 0 |
| Reads | 16 | 22,656 | 377/s | 32 ms | 89 ms | 105 ms | 0 |
| Reads | 32 | 22,897 | 381/s | 60 ms | 207 ms | 231 ms | 0 |
| Reads | 64 | 22,010 | 366/s | 121 ms | 466 ms | 509 ms | 0 |

Slowest reads at 16 concurrent clients (p95): attendance today 110 ms, personal dashboard 85 ms,
search 85 ms. Slowest write: ticket creation p95 324 ms (see §Ticket numbering).

**Interpretation.** One API container saturates at about 375 requests/s. Throughput stays flat as
concurrency grows and latency rises in proportion: requests queue on the Node.js event loop (CPU about
115–135 % of one core). PostgreSQL stayed below one core and Redis under 10 %. The limit is the single
API process, not the database. 16 back-to-back clients correspond to roughly 3,700 active users each
making one request every 10 seconds, well above the expected V1 peak. Scale out by adding API replicas
(`docs/runbooks/deploy.md`; verified with two replicas). The `ops_process_event_loop_utilization`
alert (`docs/runbooks/observability.md`) tells you when.

## Soak test

15 minutes of the read mix: 321,895 requests at 358/s, **0 errors**, p50 19 ms, p95 43 ms, p99 57 ms,
max 217 ms. Every one of the 12 endpoints had a p95 of 61 ms or less.

Resource samples every minute:

| Container | Start | After warm-up | End | Verdict |
|---|---|---|---|---|
| API | 226 MiB | 253–256 MiB from minute 2 | 256 MiB | flat after JIT/cache warm-up, no leak |
| Worker | 198 MiB | 179–206 MiB | 195 MiB | flat (garbage-collection sawtooth) |
| Redis | 14.0 MiB | 14.0–14.8 MiB | 14.6 MiB | flat |
| PostgreSQL | 114 MiB | 127–138 MiB | 136 MiB | flat (shared buffers filling) |

After the load: database connections back to the idle pool (4 `ops_app`, 2 Keycloak), 0 undispatched
outbox events, 0 failed jobs.

## Database

Query plans of the hot paths on PostgreSQL 18:

| Query | Rows in table | Plan | Execution |
|---|---|---|---|
| Support queue page (open, newest first) | 10,913 | `(organization_id, created_at, id)` index scan | 0.29 ms |
| Audit log page | 11,903 | `(organization_id, created_at)` index scan | 0.08 ms |
| Outbox claim (`FOR UPDATE SKIP LOCKED`) | 10,913 | partial `(dispatched_at, available_at)` index | 0.03 ms |
| Ticket search, selective term | 10,913 | trigram GIN bitmap scan | 0.73 ms |
| Ticket search, term in every title | 10,913 | sequential scan (correct for a 100 % match) | 8 ms |

Phase 8 volume check (session copies with 120,000 projects, 200,000 tickets and 102,000 employees
over 100 organizations):

| Query | Execution |
|---|---|
| Project health counts | 3.0 ms |
| Open-ticket count | 5.9 ms |
| Resolved today | 0.10 ms |
| Ticket by key | 0.11 ms |
| Trigram searches | 0.19–0.63 ms |
| Low-selectivity word | 15.7 ms |

No missing index was found, and no index was added speculatively.

Server settings in `docker-compose.prod.yml`:

- `log_min_duration_statement=1000`, so statements slower than 1 s are logged;
- `log_lock_waits=on`;
- `shared_buffers` 512 MB, `max_connections` 200.

`ops_app` has `idle_in_transaction_session_timeout=5min`.

Prisma 7 runs the independent reads of one call concurrently inside an interactive transaction.
node-postgres 8 emits a deprecation warning for that pattern (it will be an error in pg 9). The three
places that did this on hot paths now run the queries sequentially, and `DEPENDENCIES.md` records "do
not move to pg 9" until Prisma serializes them.

### Ticket numbering

Support tickets, requests and daily reports get gapless per-organization numbers from
`organization_counters` (upsert inside the creating transaction). The counter row stays locked until
that transaction commits, so concurrent creations of the same kind **in one organization** run one
after another. With 8 parallel writers that capped ticket creation at about 55/s for the organization
(p95 324 ms, against 26 ms for employees, which have no counter). This
is deliberate: human-readable sequential numbers (SUP-1042) matter more than parallel ticket creation,
which no realistic support desk approaches. Other organizations are not affected.

## Rate limits

Two layers (ADR-0016):

| Layer | Bucket | Limit |
|---|---|---|
| nginx, per IP | `/api/`, `/` | 50 r/s, burst 200 |
| | sign-in start and callback | 30 r/min, burst 20 |
| | Keycloak | 10 r/s, burst 50 |
| | webhooks | 20 r/s, burst 100 |
| API, per IP | default | `RATE_LIMIT_DEFAULT_PER_MINUTE` |
| | auth | `RATE_LIMIT_AUTH_PER_MINUTE` |
| API, per signed-in user | general | `RATE_LIMIT_USER_PER_MINUTE` |
| | sensitive, upload, search, attendance, Jira, GitHub | the matching `RATE_LIMIT_*_PER_MINUTE` |

The API limits are defaults in `packages/config` and can be changed in `app.env` (1–100,000).

`node scripts/release/rate-limits.ts` (run inside the Docker network) verified each layer on the
production stack. Every rejection was `429` with `Retry-After` and the JSON error envelope:

| Layer | Served | Limited |
|---|---|---|
| auth bucket | 20 | 10 |
| search bucket | 60 | 20 |
| per-user bucket | 160 | 140 |
| nginx burst | 227 | 373 |

Counters live in Redis and are shared by all API replicas.

Raise a per-user limit only with evidence (logs of legitimate users hitting `429`). Integrations and
scripts should use their own accounts.

## Repeating the measurements

```bash
# inside the Docker network of the stack, with a session cookie value in LOAD_SESSION
LOAD_BASE=http://api:4000 LOAD_ORIGIN=https://<host> LOAD_WRITES=300 LOAD_SECONDS=60 LOAD_CONCURRENCY=16 \
  node scripts/release/load.ts
```

Raise the API rate limits temporarily for load runs, or the per-user bucket dominates the results.
Restore them afterwards and run `rate-limits.ts` again.
