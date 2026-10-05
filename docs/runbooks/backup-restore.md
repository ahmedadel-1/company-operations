# Runbook: backup, restore and disaster recovery

## What is backed up, and what is not

| Data | Where | Backup | Recovery |
|---|---|---|---|
| Application database `company_ops` | PostgreSQL volume `postgres-data` | `backup` service: `pg_dump -Fc`, nightly + before every deploy | `pg-restore.sh` (this runbook) |
| Keycloak database `keycloak` (users, credentials incl. TOTP, realm config) | same PostgreSQL | same backup run | same restore |
| Attachments, photos, report files | operator's S3-compatible bucket | provider versioning / replication | §Object storage |
| Secrets | `/etc/company-ops/secrets` | organization secret manager or encrypted offline copy | `docs/runbooks/secrets.md` |
| Configuration | `/etc/company-ops/*.env`, TLS | with the secrets | re-create from the examples |
| Redis (sessions, queues, caches, rate-limit counters) | volume `redis-data`, AOF every second | **not backed up** | `docs/runbooks/redis.md` §Data loss |
| Jira and GitHub caches | application database | in the database backup | *Sync now* / reconciliation rebuild them |

## Backups

`infra/backup/pg-backup.sh` runs as the `backup` Compose service with the read-only `ops_backup` role
(`pg_read_all_data`; it cannot write). It runs as uid 999 on the `data` network, with a read-only root
filesystem. Each run writes `OPS_BACKUP_DIR/<UTC timestamp>/` with:

- `company_ops.dump`, `keycloak.dump` (custom format, compressed, each verified with `pg_restore --list`)
- `company_ops.counts.tsv`: exact row count per table, which the restore compares
- `manifest.txt`: server and `pg_dump` versions, latest applied migration, sizes, duration
- `SHA256SUMS`

Directories older than `OPS_BACKUP_RETENTION_DAYS` (default 14) are deleted at the end of each run.

```bash
dc --profile backup run --rm backup
```

### Schedule (systemd timer)

```ini
# /etc/systemd/system/company-ops-backup.service
[Unit]
Description=Company Operations database backup
[Service]
Type=oneshot
WorkingDirectory=/opt/company-ops
ExecStart=/usr/bin/docker compose --env-file /etc/company-ops/compose.env -f infra/compose/docker-compose.prod.yml --profile backup run --rm backup
ExecStartPost=/usr/local/sbin/company-ops-offsite   # your encrypted off-host copy, see below

# /etc/systemd/system/company-ops-backup.timer
[Timer]
OnCalendar=*-*-* 01:30:00
RandomizedDelaySec=15m
Persistent=true
[Install]
WantedBy=timers.target
```

`systemctl enable --now company-ops-backup.timer`. Alert when the unit fails
(`docs/runbooks/observability.md`).

### Off-host copy (required)

A backup on the same disk is not a backup. After each run, encrypt the newest directory with the
organization's tool (for example `gpg --symmetric` or `age`, with the key kept outside the host) and copy
it to storage in the same data-residency zone (`DEPLOYMENT.md` §7). Keep, for example, 30 daily and 12
monthly copies, consistent with the organizations' retention policies. Logical dumps contain personal
data and must be handled like the production database.

### Managed PostgreSQL

With `docker-compose.prod.external-data.yml`, the provider's snapshots and point-in-time recovery are
the primary backup. Keep the logical dump as the portable secondary copy (set `OPS_BACKUP_PGHOST`). The
dump needs the `ops_backup` role created by the prod-init SQL.

## Recovery objectives

| Objective | Target with this runbook | Basis |
|---|---|---|
| RPO (data loss) | ≤ 24 h with nightly dumps; ≤ the deploy interval for a deploy rollback; minutes with provider PITR | dump schedule |
| RTO (database restore on the same host) | ≤ 30 min including diagnosis; the mechanical part measured at under 2 min | drill below |
| RTO (new host) | ≤ 4 h | new host install (`docs/runbooks/deploy.md`) + restore |

Organizations that need a smaller RPO should use managed PostgreSQL with PITR, or enable WAL archiving
on the bundled PostgreSQL (not configured by this repository).

## Restore drill (quarterly, and after PostgreSQL major upgrades)

`node scripts/release/rehearse.ts restore-drill --dir <rehearsal dir>` performs the drill on a
workstation:

1. Back up with the `backup` service.
2. Restore into a scratch PostgreSQL initialized with the production roles script.
3. Verify checksums and per-table row counts.
4. Run `prisma migrate status` from the migrate image.
5. Read through `ops_app`.
6. Check that the restored Keycloak still holds the administrator's TOTP credential.

On a real host, run the same drill against a scratch server, then sign in through a staging copy.

**Phase 9 results** (production images, PostgreSQL 18.6):

| Run | Data | Backup | Restore | Checks |
|---|---|---|---|---|
| Scratch-server drill | 56,674 rows, 73 tables (48 MB database; 3.2 MB backup) | 2.96 s | 4.75 s | counts match, migrations current, `ops_app` reads, TOTP kept |
| Restore into production (rename swap below) | 59,674 rows, 73 tables (3.3 MB backup) | 2 s | 5 s restore + 71 s stop/swap/restart | identical live counts, no pending migrations, next backup OK, smoke 13/13 |

## Restore into production

Restore into new databases first. The live ones stay untouched until the swap, so a failed restore
changes nothing.

```bash
STAMP=20261004T234944Z                                         # the backup to restore
(cd /var/backups/company-ops/$STAMP && sha256sum --check --quiet SHA256SUMS)
docker cp /var/backups/company-ops/$STAMP "$(dc ps -q postgres)":/tmp/restore
dc exec -T -u postgres postgres bash -s -- /tmp/restore < infra/backup/pg-restore.sh
#   -> company_ops_restore and keycloak_restore; fails on any checksum or row-count mismatch

dc stop api worker keycloak                                    # maintenance window starts
dc exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
ALTER DATABASE company_ops RENAME TO company_ops_before_restore;
ALTER DATABASE company_ops_restore RENAME TO company_ops;
ALTER DATABASE keycloak RENAME TO keycloak_before_restore;
ALTER DATABASE keycloak_restore RENAME TO keycloak;
SQL
dc --profile migrate run --rm migrate                          # "No pending migrations" (or applies newer ones)
dc up -d --wait
node scripts/release/smoke.ts --url https://<host> --http-port 80
dc exec -T postgres rm -rf /tmp/restore
```

`pg-restore.sh` checks the checksums again inside the container, together with the row counts. After verification (sign-in works, recent records look right), drop the
`*_before_restore` databases. Keep them until then: they are the way back.

After a restore:

- Sessions live in Redis and are not part of the backup. End them all so that nobody keeps a session
  that refers to members or permissions newer than the restored data (`docs/runbooks/secrets.md`
  §Revocation, "End every application session").
- Run *Sync now* on each Jira mapping and GitHub repository (or wait for reconciliation). Jira tokens
  restored from the backup may already have been rotated, in which case the connection shows
  `NEEDS_REAUTH` and needs *Reauthorize* (`DEPLOYMENT.md` §6).
- Rebuild project timelines if needed: `dc exec -T api ops-activity-rebuild --org <slug> [--project <code>]`
  (idempotent; rehearsed).
- Outbox events newer than the backup are gone with the data they described. Nothing is replayed twice.

## Object storage

Attachments are stored under organization-scoped keys. The database holds the metadata and checksum,
the bucket holds the bytes.

- Enable **bucket versioning** (or provider replication) with a retention of at least the database
  backup retention. Deleting an attachment in the application then leaves a recoverable version.
- After a database restore to time T, objects uploaded after T are orphans (no metadata row). They are
  harmless, because nothing serves them. Remove them with a provider lifecycle rule if required.
- After losing objects but not the database, restore the bucket versions as of the same time. An
  attachment whose object is missing returns an error on download. The metadata and audit trail stay.
- Pre-signed URLs expire within minutes, so restored or moved buckets need no URL rewriting.

Not rehearsed against a real provider. The rehearsal uses SeaweedFS as a stand-in.

## Keycloak

Keycloak's state is entirely in its database: realm configuration, users, password hashes, TOTP
secrets and sessions. The nightly backup covers it, and the drill confirmed that a restored user keeps
their TOTP credential. Users created or changed after the backup are lost and must be re-created. The
realm import (`infra/docker/keycloak/realms-prod`) runs only when the realm does not exist, so a restore
is never overwritten. If the Keycloak database is lost and no backup exists, the realm re-imports on
the next start with no users. Re-create the users with the same email addresses. The application maps
a person to their membership by issuer and subject, so new Keycloak users get new subjects. Re-invite
them (`ops-bootstrap --reissue` for the administrator, invitations for everyone else).

## Disaster recovery (host lost)

1. Provision a new host (`docs/runbooks/deploy.md` §Requirements). Restore `/etc/company-ops` (secrets,
   env files) from the secret manager, or create new secrets with `init-secrets.sh` and new provider
   credentials if the old host may be compromised.
2. Install TLS and the release checkout at the **same** release tag as the backup's manifest
   (`latest_migration`).
3. `dc up -d --wait postgres redis`. The first start creates empty databases and roles.
4. Restore the latest off-host backup into the empty databases. `pg-restore.sh` reuses an existing
   empty database:
   `dc exec -T -u postgres postgres bash -s -- /tmp/restore company_ops keycloak < infra/backup/pg-restore.sh`.
5. `dc --profile migrate run --rm migrate`, then `dc up -d --wait`, then the smoke test.
6. Point DNS at the new host. Check the bucket, Jira, GitHub and SMTP as in §Restore into production.

With newly generated database passwords, the restored data works unchanged, because roles are
recreated by the init script and the dump contains no role passwords. A new `app_encryption_key`
without the old one makes stored Jira tokens unreadable (connections need *Reauthorize*).
