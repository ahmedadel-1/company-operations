# Runbook: Keycloak (identity provider)

Keycloak 26.8 runs in production mode (`kc.sh start`) behind the proxy at `https://<host>/auth`, with its
own `keycloak` database. The application is a confidential OIDC client (`ops-api`, Authorization Code +
PKCE S256 only, no direct grants, no implicit flow, no service account). The application keeps its own
session (ADR-0002) and never stores Keycloak access or refresh tokens.

## Production realm

`infra/docker/keycloak/realms-prod/company-ops-realm.json` is imported once, when realm `company-ops`
does not exist. Later edits to the file do **not** change an existing realm. Apply them in the admin
console, and record the change in the ops log. It differs from the development realm only where
production must be stricter (enforced by `packages/config/test/production-artifacts.test.ts`):

| Setting | Value |
|---|---|
| Users | none (no demo accounts) |
| TLS | `sslRequired: all` |
| Passwords | at least 12 characters, not the username or email, last 5 not reusable |
| Brute force | lockout after 5 failures, growing wait up to 15 min, not permanent |
| Self-registration, remember-me, password reset | off |
| Sessions | SSO idle 30 min, max 12 h (same as the application session) |
| Second factor | TOTP (6 digits, 30 s); LoA 2 step-up for administrators and sensitive actions (`SECURITY.md` §2) |
| Events | sign-in events and admin events stored 30 days; admin event bodies not stored |

**Realms imported before 2026-10-04 (Phase 9)** have events off. Turn them on in Realm settings →
Events (user events on, expiration 30 days; admin events on, *Include representation* off).

## Administration access

The admin console and admin API are not reachable through the public proxy (`/auth/admin/` and
`/auth/realms/master/` return 404, checked by the smoke test). Keycloak publishes its HTTP port on
`127.0.0.1:${KC_ADMIN_TUNNEL_PORT}` (default 8090) only:

```bash
ssh -L 8090:127.0.0.1:8090 operator@<host>
# then open http://127.0.0.1:8090/auth/admin/
```

The bootstrap administrator (`KC_BOOTSTRAP_ADMIN_USERNAME`, password in the `keycloak_admin_password`
secret) exists only to get started:

1. Sign in, then in the **master** realm create a named administrator account for each operator and set
   *Required actions → Configure OTP*.
2. Sign in as the named account, then disable the bootstrap user. Its password file is read only when
   the master realm is first created.

## Users

- **Create:** realm `company-ops` → Users → *Add user* (email, verified), then Credentials → set a
  temporary password. Deliver it separately from the application invitation. The person must also hold
  a membership in the application. A Keycloak account alone gives no access (sign-in shows "no
  membership").
- **Second factor:** roles that require MFA force TOTP enrolment at their first sign-in. To reset a
  lost authenticator, delete the user's OTP credential under Credentials. The next sign-in asks them to
  enrol again. Verify the person's identity first.
- **Offboarding:** disable the membership in the application, then disable the user here and use
  *Sessions → Sign out*. Back-channel logout ends their application sessions immediately.
- **Password reset by email:** configure the realm's SMTP (Realm settings → Email), then enable
  *Forgot password* under Realm settings → Login. Until then, administrators set temporary passwords.

## Failure behaviour (rehearsed)

With Keycloak stopped, signed-in users keep working. Session revalidation uses only the application
database. New sign-ins and step-ups fail: the proxy serves its "temporarily unavailable" page with
`Retry-After` for `/auth/*`. After `dc start keycloak` (healthy in about 60 s), sign-in works again with
no other action.

## Upgrades

Change the pinned image (tag **and** digest) in `docker-compose.prod.yml` and `DEPENDENCIES.md`, take a
backup (Keycloak migrates its database on start and does not migrate back), then
`dc up -d --wait keycloak`. Check the sign-in, step-up and back-channel logout flows. The production
journey in `rehearse.ts journey` covers the first two. Roll back by restoring the Keycloak database from
the pre-upgrade backup together with the previous image.

## Recovery

Covered in `docs/runbooks/backup-restore.md` §Keycloak. The realm keys (token signing) are stored in
the database, so a restored Keycloak issues tokens the application accepts without configuration
changes.
