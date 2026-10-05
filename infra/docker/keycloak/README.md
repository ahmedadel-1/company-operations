# Keycloak (development)

Keycloak 26.8.0 runs in `start-dev --import-realm` mode against its own PostgreSQL database
(`keycloak` role and database, created by `infra/docker/postgres/init`). Health checks are enabled
(`KC_HEALTH_ENABLED=true`) and served on the management port 9000 inside the Compose network.

- Admin console: <http://localhost:8080/admin> (bootstrap admin from `.env`:
  `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD`).
- `realms/company-ops-realm.json`: the `company-ops` realm. Values in `${...}` are substituted from the
  container environment at import (`OIDC_CLIENT_SECRET`, `KC_DEMO_USER_PASSWORD`, `APP_PUBLIC_URL`,
  `OIDC_BACKCHANNEL_LOGOUT_URL`); the file itself holds no secrets.
  - Client `ops-api`: confidential, Authorization Code only, PKCE S256 required, exact redirect URI
    `${APP_PUBLIC_URL}/api/v1/auth/callback`, back-channel logout with session required.
  - Browser flow `loa browser`: level 1 = password, level 2 = TOTP; `acr.loa.map` = `{"pwd":1,"mfa":2}`.
    The API requests `acr_values=mfa` for step-up and for ORG_ADMIN at login.
  - Brute-force protection, password policy (12+ characters, not username/email), no self-registration
    or reset, SSO idle 30 min / max 12 h.
  - Demo users with fixed ids matching `packages/core/src/dev-seed/demo-data.ts`: `org.admin`, `gm`,
    `hr`, `employee`, `disabled`, `outsider`.

The realm is imported only if it does not exist (`IGNORE_EXISTING`). Changes to this file, or to the
substituted variables, need a dev data reset (`docs/DEPLOYMENT.md` §2). Entra ID brokering is not
configured.
