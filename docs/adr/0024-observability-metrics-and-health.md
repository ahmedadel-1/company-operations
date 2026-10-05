# ADR-0024: Observability — metrics, health and logs without a vendor SDK

Date: 2026-10-04 · Status: Accepted (Phase 9, P9-5)

## Context
Production needs liveness/readiness for the orchestrator (Docker health checks, `docker compose up --wait`), metrics for capacity and SLOs, and logs for incidents. The roadmap listed "Sentry opt-in; OpenTelemetry evaluation". Constraints: no new runtime dependencies without review, no per-employee surveillance metrics (PRD non-goal), nothing reachable from the internet that leaks internals, and no pretending that an alerting provider exists when the operator has not configured one.

## Decision
1. **Metrics: Prometheus text exposition from a small in-repo registry** (`packages/core/src/platform/observability/metrics.ts`): counters, histograms and collect-time gauges with fixed label sets, a series cap (2 000) and isolated collectors (a failing collector increments `ops_metrics_collector_errors` instead of breaking the scrape). No `prom-client` or OpenTelemetry SDK dependency.
2. **Internal ops listeners only** (`ops-server.ts`, GET only): API `API_OPS_PORT` (default 0 = off; production compose 9464) serves `/metrics`; worker `WORKER_OPS_PORT` (default 4001) serves `/health/live`, `/health/ready`, `/metrics`. They bind inside the container network; the proxy never routes to them. Production compose publishes no ops port.
3. **Labels are aggregate only.** API: `http_requests_total{method,route,status}` and `http_request_duration_seconds{method,route}` with the matched route template (`/api/v1/support/tickets/:id`), never a concrete id or query; unmatched routes are `unmatched`. Worker: `queue_jobs{queue,state}`, `outbox_events{state}`, `outbox_oldest_pending_seconds`, `worker_ready`. Process metrics (heap, RSS, event-loop utilisation, uptime). No user, member, organization or employee identifiers in any label.
4. **Health semantics.** Liveness answers while the process runs. Readiness checks PostgreSQL and Redis and turns 503 as soon as shutdown begins (`beforeApplicationShutdown` sets draining), so a proxy or load balancer stops sending traffic before connections close. Open SSE streams are ended on shutdown so the HTTP server can close within the grace period.
5. **Logs.** Structured JSON (pino) to stdout with central redaction (`@company-ops/shared` logging), request id on every line, no query strings, no headers; successful health probes log at `debug`. The Docker `local` log driver rotates (20 MB × 5 per container).
6. **Error tracking (Sentry) and tracing (OpenTelemetry): not in V1.** Both need a new SDK dependency and an external collector; the request id in logs and the metrics above cover V1 diagnostics. Evaluated and deferred; adding either later is an additive, opt-in change behind an env flag.
7. **Alerting is the operator's.** `docs/runbooks/observability.md` defines SLOs and example Prometheus rules; the repository ships no alerting service and the documentation says so.

## Consequences
- Operators scrape `api:9464/metrics` and `worker:4001/metrics` from inside the Docker network (or a sidecar); the endpoints are unauthenticated and therefore never published or proxied (accepted, documented in `docs/runbooks/observability.md`).
- Dashboards and alerts depend on the operator's Prometheus; until one exists, the health checks and `docker compose ps` are the only automated signals.
- No vendor lock-in and no extra supply-chain surface.
