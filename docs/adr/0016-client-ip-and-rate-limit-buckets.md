# ADR-0016: Client IP derivation and rate-limit buckets

Date: 2026-10-02 · Status: Accepted

## Context
SECURITY §5 asks for per-IP limits on unauthenticated traffic, per-user limits on authenticated traffic, stricter limits on sensitive operations and a separate webhook limit. Two problems surfaced during the Phase 1 security review:

1. **Spoofable client IP.** Without Nginx (development, E2E, small installs), the browser reaches the API through the Next.js `/api` rewrite. Next.js passes the client's `X-Forwarded-For` through unchanged. With `TRUST_PROXY_HOPS=1`, the API would then take an IP chosen by the client as its rate-limit and audit key, so one client could rotate through unlimited fresh per-IP buckets.
2. **Webhooks sharing the browser bucket.** Keycloak back-channel logout used the strict per-IP `auth` bucket. A burst of logouts (for example, an administrator ending many sessions) from Keycloak's single address could be throttled. That would leave application sessions alive. In the other direction, browser sign-in attempts from a shared address could block logout delivery.

## Decision
- **Client IP** comes only from Express `trust proxy = TRUST_PROXY_HOPS`. That value counts the proxies in front of the API that append the connecting address to `X-Forwarded-For`.
  - In production, Nginx routes `/api` directly to the API (`TRUST_PROXY_HOPS=1`).
  - The web app's `proxy.ts` deletes `Forwarded`, `X-Forwarded-*` and `X-Real-IP` from every `/api` request it forwards. Behind it, the API sees the web server as the client, so per-IP limits are coarse. Per-user limits still apply. This is accepted for development and installs without Nginx, and documented in DEPLOYMENT §6.
- **Buckets** (all per minute, configurable, Redis-backed, keys `ops:rl:<bucket>:<hash>`):
  - Per IP, before authentication:
    - `default` applies to all routes except health and webhooks.
    - `auth` applies additionally to sign-in, step-up and callback.
    - `webhook` applies only to server-to-server endpoints marked `@WebhookRateLimit()`. It is not counted against `default` or `auth`.
  - Per user, after `SessionGuard`, keyed by the SHA-256 of the user id:
    - `user` applies to every authenticated request.
    - `sensitive` applies additionally where declared (role grant/revoke, organization settings, employee create/status/invitation).
    - `upload` applies additionally to attachment upload intents.
- Over-limit responses are `429 RATE_LIMITED` with `Retry-After`.

## Consequences
- Tests prove:
  - 429 per bucket;
  - isolation between users and between client IPs;
  - that a spoofed `X-Forwarded-For` is ignored without trusted hops;
  - that the proxy strips forwarding headers;
  - that webhooks do not consume the auth bucket;
  - that Redis keys never contain raw identifiers.
- Exposing the API port directly while `TRUST_PROXY_HOPS` > 0 would make the client IP spoofable again. DEPLOYMENT §6 forbids it.
- Jira and GitHub webhook endpoints (Phases 4 and 5) must use `@WebhookRateLimit()`.
