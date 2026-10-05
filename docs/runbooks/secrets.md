# Runbook: secrets

Every secret is a file under `OPS_SECRETS_DIR` (default `/etc/company-ops/secrets`), mounted by Compose at
`/run/secrets/<name>` and read through `*_FILE` variables. No secret is a plain environment variable,
none is in `compose.env` or `app.env`, and none is ever logged. The configuration loader names a bad
variable but never echoes a value or path (`packages/config/src/secret-files.ts`). Setting both
`NAME` and `NAME_FILE` is rejected at startup.

## Inventory

| File | Used by | Format | Created by |
|---|---|---|---|
| `database_url` | API, worker | `postgresql://ops_app:<pw>@postgres:5432/company_ops` | init script |
| `database_migration_url` | migrate | `postgresql://ops_migrator:<pw>@…` | init script |
| `redis_url` | API, worker | `redis://:<pw>@redis:6379` (`rediss://` for managed TLS) | init script |
| `oidc_client_secret` | API, Keycloak (realm import) | 48 hex | init script |
| `app_encryption_key` | API, worker | 32 random bytes, base64 | init script |
| `app_encryption_keys_previous` | API, worker | `id:base64[,id:base64…]`, empty when none | init script (empty) |
| `s3_secret_access_key` | API, worker | provider secret | **operator** |
| `postgres_superuser_password` | PostgreSQL | 48 hex | init script |
| `ops_app_db_password`, `ops_migrator_db_password`, `ops_backup_db_password`, `keycloak_db_password` | PostgreSQL init, backup, Keycloak | 48 hex | init script |
| `keycloak_admin_password` | Keycloak bootstrap admin | 48 hex | init script |
| `redis_password` | Redis | 48 hex | init script |
| `smtp_password` | worker (SMTP overlay) | provider secret | operator |
| `jira_oauth_client_secret` | API, worker (Jira overlay) | Atlassian app secret | operator |
| `github_app_private_key`, `github_app_client_secret`, `github_webhook_secret` | API, worker (GitHub overlay) | from the GitHub App | operator |
| `private_ca.pem` (not secret, mounted the same way) | API, worker (private-CA overlay) | PEM CA certificate(s) | operator |

`S3_ACCESS_KEY_ID` is not secret and lives in `app.env`.

## Provisioning

```bash
sudo bash scripts/ops/init-secrets.sh /etc/company-ops/secrets
printf '%s' '<provider secret>' | sudo install -m 0444 /dev/stdin /etc/company-ops/secrets/s3_secret_access_key
sudo bash scripts/ops/init-secrets.sh /etc/company-ops/secrets   # exits 0 once nothing required is missing
```

- The script never overwrites an existing file and never prints a value. It only reports names.
  Running it again is safe, and it also re-applies the permissions.
- With managed data stores, write `database_url`, `database_migration_url` and `redis_url` yourself
  (with `sslmode=require` / `rediss://` as the provider requires) before running it. `OPS_DB_HOST`,
  `OPS_DB_PORT`, `OPS_DB_NAME`, `OPS_REDIS_HOST` and `OPS_REDIS_PORT` change the generated URLs.
- Type the provider secrets through `install … /dev/stdin` (as above) or an editor, never as a command
  argument. Arguments end up in shell history and `ps`.

### Permission model

The directory is `root:root 0700`, so no unprivileged host user can list or read it. Files are `0444`
because Docker Compose bind-mounts file secrets with their host ownership and mode, and the containers
read them as non-root users (`node` uid 1000, `postgres`/`redis` uid 999). The closed directory is the
access boundary on the host. Inside a container, `/run/secrets` holds only the secrets that service
declares in the Compose file. The worker, for example, never receives the OIDC client secret or any
database password other than its own URL.

Back up the directory with the organization's secret manager or as an encrypted offline copy
(`DEPLOYMENT.md` §10). **Losing `app_encryption_key` (and its retired entries) makes every stored Jira
token undecryptable**, and Jira connections then need *Reauthorize*. Cached GitHub installation tokens
and session logout hints are re-created on their own.

## Rotation

The general rule: change the credential at its source, write the new value to the file, then recreate
the containers that read it. Compose re-reads secret files when it recreates a container. Every
procedure below except GitHub/Jira/SMTP/S3 was rehearsed on the running production stack with
`node scripts/release/rehearse.ts rotate`. The rehearsal checked that the old database and Redis
passwords are refused, that an existing session survives the encryption-key rotation, and that a full
sign-in with the new OIDC client secret works.

### Database runtime password (`ops_app`)

```bash
NEW="$(openssl rand -hex 24)"
printf "ALTER ROLE ops_app PASSWORD '%s';\n" "$NEW" | dc exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q
printf '%s\n' "$NEW" | sudo install -m 0444 /dev/stdin /etc/company-ops/secrets/ops_app_db_password
printf 'postgresql://ops_app:%s@postgres:5432/company_ops\n' "$NEW" | sudo install -m 0444 /dev/stdin /etc/company-ops/secrets/database_url
unset NEW
dc up -d --force-recreate --wait api worker
```

Connections opened before the change stay valid until the containers are recreated, so there is no
outage window. Rotate `ops_migrator` and `ops_backup` the same way, writing `database_migration_url` or
`ops_backup_db_password`. Nothing needs recreating for them, because both are used only by one-shot jobs.

### Redis password

```bash
NEW="$(openssl rand -hex 24)"
printf '%s' "$NEW" | dc exec -T -e REDISCLI_AUTH="$(sudo cat /etc/company-ops/secrets/redis_password)" redis redis-cli -x CONFIG SET requirepass
printf '%s\n' "$NEW" | sudo install -m 0444 /dev/stdin /etc/company-ops/secrets/redis_password
printf 'redis://:%s@redis:6379\n' "$NEW" | sudo install -m 0444 /dev/stdin /etc/company-ops/secrets/redis_url
unset NEW
dc up -d --force-recreate --wait api worker
```

`CONFIG SET` changes the live server and keeps existing connections. On its next restart Redis reads
the new file. Between the two commands the API and worker keep their authenticated connections, but a
reconnect would fail until they are recreated, so run the commands back to back.

### OIDC client secret

Regenerate it in the Keycloak admin console (tunnel, realm `company-ops` → Clients → `ops-api` →
Credentials → *Regenerate*), write the value to `oidc_client_secret`, then
`dc up -d --force-recreate --wait api`. Sign-ins started before the recreate fail at the code exchange
and simply start again. Existing sessions are unaffected. Keycloak keeps the regenerated secret in its
database. The file only seeds the first realm import.

### Application encryption key

Data encrypted with a key stays readable for as long as that key is listed as retired. New data always
uses the current key.

1. Choose the next id (`k1` → `k2`).
2. Prepend the current key to `app_encryption_keys_previous` as `<current id>:<current key>`. Keep
   older entries. At most 5 are accepted, and startup rejects more. Drop an entry only when nothing
   encrypted with it can still exist: after the absolute session lifetime (12 h by default) and after
   every Jira connection has refreshed its tokens (about an hour while syncing). Cached GitHub
   installation tokens expire within an hour.
3. Write a new key: `openssl rand -base64 32 | sudo install -m 0444 /dev/stdin …/app_encryption_key`.
4. Set `APP_ENCRYPTION_KEY_ID=k2` in `app.env`.
5. `dc up -d --force-recreate --wait api worker` (both together, since they share the key set).

Never leave the outgoing key out of the retired list. Jira connections would move to `NEEDS_REAUTH`,
and signing out of sessions created before the rotation would no longer end the Keycloak session
(the logout hint cannot be decrypted).

### Keycloak bootstrap admin, PostgreSQL superuser, Keycloak database

- Bootstrap admin: change it in the admin console (master realm → Users). The file is only read when
  the master realm is first created. Better still, create named administrator accounts with a second
  factor and disable the bootstrap user (`docs/runbooks/keycloak.md`).
- PostgreSQL superuser: `ALTER ROLE postgres PASSWORD …` over `dc exec postgres psql`, then update the
  file. Only the init script uses it.
- Keycloak database: `ALTER ROLE keycloak PASSWORD …`, update `keycloak_db_password`, then
  `dc up -d --force-recreate --wait keycloak`.

### Provider secrets (S3, SMTP, Jira, GitHub)

Create the new credential at the provider while the old one still works, write the file, recreate the
reading services (S3 and Jira: `api worker`; SMTP: `worker`; GitHub: `api worker`), then revoke the old
credential. The GitHub key and webhook-secret procedure is in `DEPLOYMENT.md` §6 (Phase 5). These were
not rehearsed against the real providers. The file-reading path they use is the same one the
rehearsed secrets use.

## Revocation and incident response

- **Suspected leak of one secret:** rotate it as above, then check access logs for the period
  (`docs/runbooks/observability.md`).
- **End every application session** (users sign in again; nothing else is affected):
  ```bash
  dc exec -T redis sh -c 'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)";
    redis-cli --scan --pattern "ops:sess*" | xargs -r -n 500 redis-cli del > /dev/null'
  ```
  Rehearsed: every session key was removed and the old session cookie was answered with 401. Rotating
  the encryption key does **not** end sessions. The session ID token is decrypted only for the
  logout hint.
- **Suspected host compromise:** restore onto a clean host (`docs/runbooks/backup-restore.md` §Disaster
  recovery) and rotate everything in the inventory there, including provider credentials. Revoke the
  GitHub App private key and the Atlassian app secret at the providers, end every session as above,
  sign out all Keycloak sessions (realm → Sessions → *Sign out all active sessions*), and rotate the
  encryption key with an empty retired list. Jira connections then need *Reauthorize*, because the
  stored tokens are both possibly exposed and undecryptable.
- **A person leaves:** disable the membership in the application (effective on their next request),
  disable the user in Keycloak, and sign out their Keycloak sessions. Back-channel logout removes the
  application sessions (`DEPLOYMENT.md` §6).
