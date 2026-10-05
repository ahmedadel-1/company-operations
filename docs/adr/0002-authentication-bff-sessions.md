# ADR-0002: Authentication — Keycloak OIDC with API-side BFF sessions; app-owned authorization; MFA step-up

Date: 2026-10-02 · Status: Accepted (amended during the Phase 0 remediation pass: MFA step-up, Entra timing; amended in Phase 1: no token refresh — see "Amendment (Phase 1)")

## Context
Requirements: Keycloak OIDC, SSO, MFA via the identity provider, logout, refresh, role mapping, future Entra ID federation; tokens must not be exposed unnecessarily; CSRF protection appropriate to the architecture. Options considered:
1. SPA-style public client holding tokens in the browser — rejected (token exposure, XSS blast radius).
2. Auth.js in Next.js — v5 is still published under the `beta` tag (npm dist-tags, 2026-10-02); puts session logic in the web tier while the API must authorize anyway.
3. **API as confidential OIDC client (BFF) with server-side sessions** — chosen.

Contextual permissions (project membership, manager chain, department scope) and per-org roles cannot be expressed well in IdP tokens.

## Decision
- The NestJS API performs Authorization Code + PKCE with Keycloak using `openid-client`, keeps a Redis-backed server-side session, and issues an HttpOnly, Secure, SameSite=Lax `__Host-` session cookie. Only the ID token is kept (encrypted, for `id_token_hint` at logout); access and refresh tokens are discarded (see the Phase 1 amendment).
- Web and API are served same-site behind the reverse proxy; Next.js server components forward the cookie to the API.
- CSRF: synchronizer token header + Origin check on state-changing requests.
- **Keycloak authenticates; our database authorizes** (ADR-0012). Optional IdP-group → role mappings may be applied at login, but grants live in our DB and are audited.
- **MFA for privileged access via step-up**: Keycloak realm configured with an ACR→LoA mapping (e.g. `mfa` → LoA 2) and a browser flow with *Condition – Level of Authentication* sub-flows (documented in the Keycloak Server Administration Guide, "ACR to LoA mapping" / "Step-up authentication"). The API inspects the ID token `acr` claim; if the member holds a privileged capability (`SECURITY.md` §2.3) and the session's `acr` is below the required level, privileged endpoints return `401 MFA_REQUIRED` and the UI triggers re-authentication with `acr_values=mfa`. The API validates the returned `acr`; it never trusts the login UI alone.
- **Microsoft Entra ID federation is later/optional**: added as a Keycloak identity provider (brokering) without application changes. Not part of Phase 1.

## Consequences
- No tokens in browser JS; logout and revocation are server-controlled.
- API is stateful in Redis for sessions (Redis loss = users re-login).
- Future native/mobile clients will use bearer tokens validated via JWKS — supported by design, not built in V1.
- Exact Keycloak realm configuration for step-up is implemented and tested in Phase 1 (P1-2, P1-9).

## Amendment (Phase 1): no token refresh

The original context listed "refresh" as a requirement and the decision said tokens are stored. Phase 1B shipped without refresh; this amendment makes that the decision and records its semantics.

### Decision
The API **does not store or use access or refresh tokens and never refreshes against Keycloak**. After the code exchange it validates the ID token, creates its own session and discards the access and refresh tokens. The API never calls Keycloak on behalf of the user (authorization lives in our database, ADR-0012), so it has no use for an access token; keeping a refresh token would only add a long-lived credential to Redis.

### Session versus token lifetime
- The **application session** is authoritative for API access: idle timeout `SESSION_IDLE_TIMEOUT_MINUTES` (default 30, sliding) and absolute timeout `SESSION_ABSOLUTE_TIMEOUT_MINUTES` (default 12 h). Neither is extended by Keycloak.
- The **Keycloak SSO session** (realm: SSO idle 30 min, max 12 h) only decides whether a new login needs credentials again. Token expiry (`exp` of the ID token) is checked once, at the callback; it does not end the application session.
- **Privileged actions** additionally require an MFA authentication no older than `MFA_MAX_AGE_MINUTES`; when it is older the API returns `401 MFA_REQUIRED` and the UI starts step-up (a new authorization request with `acr_values=mfa`, which rotates the session).

### Logout, revocation and back-channel logout
- **User logout** (`POST /api/v1/auth/logout`): the session is deleted from Redis immediately (the cookie is then useless), the event is audited, and the browser is sent to Keycloak's end-session endpoint with `id_token_hint` to end the SSO session.
- **Back-channel logout** (OIDC Back-Channel Logout 1.0): when an administrator signs a user out in Keycloak, or the SSO session ends there, Keycloak posts a signed logout token; the API verifies it (signature, issuer, audience, `events`, `jti` replay) and deletes every application session with that `sid`. Tokens without `sid` are ignored (the client requires `sid`).
- **Membership disabled or roles changed in the application**: effective on the member's **next request** — every request revalidates the membership, the organization status and `authz_version`; a disabled member's session is destroyed (`401 SESSION_EXPIRED`), changed grants reload permissions and rotate the session id.
- **User disabled in Keycloak**: new logins are refused by Keycloak at once. An already-issued application session is **not** ended by disabling alone, because there is no refresh call that could fail. Operators revoke access immediately by either signing the user out in Keycloak (back-channel logout) or disabling the membership in the application; otherwise the session ends at its idle or absolute timeout. This is documented in `SECURITY.md` §3.3 and `DEPLOYMENT.md`.

### Consequences
- No refresh tokens or access tokens exist anywhere in our systems; a Redis compromise exposes opaque session records and encrypted ID tokens only.
- Revocation latency for an IdP-only disable is bounded by the session timeouts unless the operator also signs the user out; the runbook says to do both.
- If a future feature needs to call an IdP-protected API as the user, refresh would be reintroduced by a new ADR (encrypted refresh token, rotation, revocation on logout).
- Tests: `apps/api/test/keycloak-oidc.int.test.ts` (no tokens in the stored session, user logout, back-channel logout, Keycloak-disabled user cannot log in while an existing session persists until signed out), `apps/api/test/http-security.int.test.ts` (disabled membership ends the session on the next request; grant changes rotate the session).
