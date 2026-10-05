# Runbook: Redis

## Decision (Phase 9)

V1 runs **one Redis 8.10 instance** (bundled container or a managed single endpoint). There is no
Sentinel or Cluster. Redis holds only data that is either short-lived or reconstructable:

| Key space | Purpose | Lifetime | If lost |
|---|---|---|---|
| `ops:sess:*`, `ops:sess-idp:*` | application sessions | idle 30 min / absolute 12 h | users sign in again |
| OIDC transactions, logout-token replay ids | sign-in in progress | minutes | the sign-in restarts |
| `bull:*` | BullMQ queues, repeatable job schedules, failed-job history (30 days) | per job | see §Data loss |
| `dash:*` | dashboard cache | 60 s | recomputed from PostgreSQL |
| rate-limit counters | throttling | one window | limits reset |
| Jira/GitHub coordination locks, GitHub installation tokens (encrypted) | integration coordination | minutes to 1 h | re-acquired |
| pub/sub `realtime` | live-update hints | none (not stored) | clients refetch on reconnect |

The source of truth is always PostgreSQL. Outbox events are written in the same transaction as the
change they describe, and moved to queues only afterwards. That is why Redis has no backup
(`DEPLOYMENT.md` §10). High availability would add operational weight that the recovery behaviour
below makes unnecessary for V1. Organizations that need it can use a managed Redis with automatic
failover behind a single endpoint (`rediss://` URL, external-data overlay). The application needs
nothing else for that.

## Configuration

`--appendonly yes --appendfsync everysec` (at most about 1 s of writes lost on a crash), RDB snapshots
as a second copy, `maxmemory 768mb` (`REDIS_MAXMEMORY`), **`maxmemory-policy noeviction`**. BullMQ
requires `noeviction`: an evicted job key corrupts a queue. Sessions and caches carry their own TTLs, so
memory is bounded by traffic rather than history. When `maxmemory` is reached, writes fail visibly
(sign-in and job enqueueing return errors) instead of silently dropping data. Alert well before that.

Password from the `redis_password` secret, written to a tmpfs config file at start, so it never
appears on the command line or in `ps`. The container runs as uid 999 with a read-only root
filesystem, on the internal `data` network only (no published port). Application clients connect with
a 2 s timeout, an offline queue that is disabled, and one retry per command. A Redis outage therefore
fails requests quickly instead of hanging them. The live-update subscriber keeps its own reconnecting
connection.

Measured in the soak test: 14–15 MB used after 15 minutes at 358 requests/s.

## Outage behaviour (rehearsed with `docker stop`)

- API requests that need Redis (every authenticated request, because sessions live there) answer
  `503 DEPENDENCY_UNAVAILABLE` within 10–30 ms. Health: liveness stays 200, readiness reports Redis down
  (the uptime monitor alerts).
- The worker logs structured connection errors (no stack spam) and stops taking jobs. The outbox
  keeps accumulating events in PostgreSQL.
- After `dc start redis`, the API and worker reconnect without a restart. Sessions persist (AOF).
  Accumulated outbox events are dispatched: 15 writes made during the rehearsed outage produced 5
  outbox events, and all were delivered after recovery.

## Data loss (volume destroyed or corrupted)

1. `dc up -d --wait redis` starts an empty instance. The API and worker reconnect. Users sign in again.
2. The worker re-registers its job schedules (SLA and request sweeps, attendance, reports, retention,
   Jira and GitHub reconciliation) when it starts. Restart it once: `dc restart worker`. The outbox relay
   is a polling loop in the worker and needs nothing.
3. Jobs that were queued but not yet processed are gone. Their outbox events are already marked
   dispatched. Re-queue the events of the loss window. Processors are idempotent (notifications dedupe
   on `dedupe_key`, deliveries are unique per notification and channel, timeline entries per source
   event), so re-running an event that was already processed changes nothing:
   ```sql
   -- as ops_app or a superuser in company_ops; adjust the window to the incident
   UPDATE outbox_events SET dispatched_at = NULL, attempts = 0, available_at = now()
   WHERE dispatched_at > now() - interval '30 minutes';
   ```
   Rehearsed on the production stack: `FLUSHALL` (1,225 keys), worker restart (18 scheduled jobs in 5
   queues re-created; Jira and GitHub were disabled), then 10,913 events re-queued. The outbox drained
   in 23 s, the queues were idle after 52 s, and no job failed. Notification and timeline counts were
   unchanged. Those events, from the load test, address no recipients, so duplicate suppression itself
   is covered by the outbox and notification integration tests rather than by this run.
4. Integration state converges through reconciliation (Jira hourly, GitHub every 30 minutes). Run
   *Sync now* to hurry it.
5. Failed-job history (admin → Failed jobs) restarts empty.

## Capacity and monitoring

- `INFO memory` → `used_memory` against `maxmemory`. Alert at 70 %.
- `INFO persistence` → `aof_last_write_status:ok`, `rdb_last_bgsave_status:ok`.
- Worker metric `ops_queue_jobs{state="waiting"}` growing for more than 10 minutes means the worker
  is not keeping up or is down.

```bash
dc exec -T redis sh -c 'REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli INFO memory' | grep -E '^(used_memory_human|maxmemory_human):'
```
