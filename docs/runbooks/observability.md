# Runbook: observability (health, metrics, logs, alerts)

Design: ADR-0024. The repository ships the signals (health endpoints, Prometheus metrics, structured
logs) but **no monitoring or alerting service**. The operator connects these to their own uptime
monitor, Prometheus and log stack. Until that exists, Docker health checks and `docker compose ps` are
the only automated signals.

## Health

| Endpoint | Where | Meaning |
|---|---|---|
| `GET /api/v1/health/live` | public, through the proxy | API process is running |
| `GET /api/v1/health/ready` | public, through the proxy | API can serve: PostgreSQL and Redis reachable, not draining. 503 otherwise |
| `GET http://worker:4001/health/live`, `/health/ready` | internal network only | worker running / database, Redis and queues usable, not draining |
| `GET /healthz` | public | web app running |
| proxy `127.0.0.1:8081/nginx-health` | inside the proxy container | proxy running |
| Keycloak `:9000/auth/health/ready` | inside the Keycloak container | Keycloak and its database ready |

Readiness bodies name the failing dependency (`database`, `redis`) and nothing else. Point the
external uptime monitor at `https://<host>/api/v1/health/ready` (every minute, alert after 3
failures) and at `/healthz`.

## Metrics

Prometheus text format on internal listeners, which are never published or proxied and have no
authentication: `api:9464/metrics` and `worker:4001/metrics`. Scrape them from a Prometheus (or agent)
container attached to the Compose project's `edge` network:

```yaml
# prometheus.yml (excerpt); run Prometheus with `--network company-ops_edge` or an overlay service
scrape_configs:
  - job_name: company-ops-api
    dns_sd_configs: [{ names: [api], type: A, port: 9464 }]   # finds every API replica
  - job_name: company-ops-worker
    static_configs: [{ targets: ['worker:4001'] }]
```

| Metric | Type | Labels | Source |
|---|---|---|---|
| `ops_http_requests_total` | counter | `method`, `route` (template, e.g. `/api/v1/support/tickets/:id`), `status` (`2xx`…`5xx`) | API |
| `ops_http_request_duration_seconds` | histogram (5 ms … 10 s) | `method`, `route` | API |
| `ops_api_ready` | gauge | | API (0 while draining) |
| `ops_queue_jobs` | gauge | `queue`, `state` (`waiting`, `active`, `delayed`, `failed`, `completed`) | worker |
| `ops_outbox_events` | gauge | `state` (`pending`, `failed`) | worker |
| `ops_outbox_oldest_pending_seconds` | gauge | | worker |
| `ops_worker_ready` | gauge | | worker |
| `ops_process_resident_memory_bytes`, `ops_process_heap_used_bytes`, `ops_process_uptime_seconds` | gauge | | both |
| `ops_process_event_loop_utilization` | gauge (0–1, since the previous scrape) | | both |
| `ops_metrics_collector_errors` | gauge | | both |

No label carries a user, member, employee, organization or record identifier, so the metrics cannot be
used to watch individual people (PRD non-goal). Concrete paths never appear: unmatched routes are
reported as `unmatched`.

## Service level objectives (V1)

| SLO | Objective | Indicator |
|---|---|---|
| Availability | 99.5 % of API requests per 30 days are not `5xx` | `ops_http_requests_total` |
| Latency | 95 % of API requests complete within 250 ms (PRD target: p95 < 300 ms for list and detail) | histogram bucket `le="0.25"` |
| Freshness of background work | the oldest pending outbox event is younger than 60 s, 99 % of the time | `ops_outbox_oldest_pending_seconds` |
| Backups | one verified backup every 24 h | backup unit exit status, `manifest.txt` |

Measured on the rehearsal host: p95 43 ms at 358 requests/s for 15 minutes with no errors
(`docs/runbooks/performance.md`).

## Example alert rules

```yaml
groups:
  - name: company-ops
    rules:
      - alert: OpsApiErrorRateHigh
        expr: sum(rate(ops_http_requests_total{status="5xx"}[5m])) / sum(rate(ops_http_requests_total[5m])) > 0.02
        for: 10m
        labels: { severity: page }
      - alert: OpsApiLatencyHigh
        expr: |
          sum(rate(ops_http_request_duration_seconds_bucket{le="0.25",route!~".*/events/stream"}[10m]))
            / sum(rate(ops_http_request_duration_seconds_count{route!~".*/events/stream"}[10m])) < 0.95
        for: 15m
        labels: { severity: ticket }
      - alert: OpsApiSaturated
        expr: avg_over_time(ops_process_event_loop_utilization{job="company-ops-api"}[10m]) > 0.8
        for: 15m
        labels: { severity: ticket }    # add an API replica (deploy.md) before latency suffers
      - alert: OpsOutboxStuck
        expr: ops_outbox_oldest_pending_seconds > 300
        for: 5m
        labels: { severity: page }
      - alert: OpsOutboxFailedEvents
        expr: ops_outbox_events{state="failed"} > 0
        labels: { severity: ticket }
      - alert: OpsJobsFailing
        expr: increase(ops_queue_jobs{state="failed"}[1h]) > 10
        labels: { severity: ticket }
      - alert: OpsQueueBacklog
        expr: ops_queue_jobs{state="waiting"} > 1000
        for: 10m
        labels: { severity: ticket }
      - alert: OpsWorkerDown
        expr: up{job="company-ops-worker"} == 0 or ops_worker_ready == 0
        for: 5m
        labels: { severity: page }
      - alert: OpsMemoryHigh
        expr: ops_process_resident_memory_bytes > 0.85 * 1073741824   # API and worker limit 1 GiB
        for: 15m
        labels: { severity: ticket }
      - alert: OpsMetricsCollectorErrors
        expr: ops_metrics_collector_errors > 0
        for: 10m
        labels: { severity: ticket }
```

Also alert, outside Prometheus, on:

- uptime-check failure;
- certificate expiry under 21 days;
- backup unit failure;
- disk usage over 80 % (PostgreSQL volume, backup directory, Docker log directory);
- Redis memory over 70 % of `maxmemory`;
- Jira connections in `NEEDS_REAUTH` (admins are also notified in the application);
- a spike of `Jira webhook rejected` / `GitHub webhook rejected` log lines.

## Logs

Every application writes one JSON object per line to stdout (pino). The Docker `local` driver keeps
5 × 20 MB per container. Ship them with the operator's agent if longer retention is needed.

- Fields: `level` (30 info, 40 warn, 50 error), `time`, `msg`, `requestId` on every line of a request,
  and `orgId` and `userId` (internal ids, not names) once the caller is known.
- Redaction is central (`packages/shared/src/logging.ts`). These are replaced with `[REDACTED]`:
  - authorization, cookie, CSRF and webhook-signature headers, and `Set-Cookie`;
  - fields named like passwords, secrets, tokens, private keys, session ids, invitation tokens,
    nonces and code verifiers;
  - in free text: private keys, bearer tokens, JWTs, GitHub tokens, sensitive URL parameters, URL
    credentials and session cookies;
  - attendance coordinates.

  The application never sees OTP codes (Keycloak handles them). Query strings are never logged. The proxy logs `$uri` without the query, so OIDC codes and pre-signed
  signatures never appear. Regression tests cover the redaction list.
- **Correlate** a user's report with the `X-Request-Id` response header. The same id is in the proxy
  access log (`request_id`) and in every API line for that request (`requestId`).
- Successful health probes log at `debug` and are not visible at the production level `info`.

```bash
dc logs --since 1h api | grep '"level":50'                    # errors
dc logs --since 1h api proxy | grep '<request id>'            # one request end to end
```

## Error tracking and tracing

Not included in V1 (ADR-0024 §6). Sentry and OpenTelemetry each need an SDK dependency and an external
collector. Request ids, metrics and logs cover V1 diagnostics. Adding either later is an opt-in change.
