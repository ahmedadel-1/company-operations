#!/usr/bin/env bash
# Logical PostgreSQL backup (docs/runbooks/backup-restore.md). Runs as the `backup` compose service
# (profile "backup") with the read-only ops_backup role; never as a superuser.
#
#   docker compose --profile backup run --rm backup
#
# Writes /backup/<UTC timestamp>/{company_ops,keycloak}.dump (pg_dump custom format), SHA256SUMS and
# manifest.txt (sizes, server version, latest applied migration, per-table row counts), verifies every
# archive with pg_restore --list, then removes backup directories older than OPS_BACKUP_RETENTION_DAYS.
# Copy the directory off the host afterwards (encrypted); a backup on the same disk is not a backup.
set -euo pipefail
umask 077

export PGHOST="${PGHOST:-postgres}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-ops_backup}"
if [[ -n "${PGPASSWORD_FILE:-}" ]]; then
  PGPASSWORD="$(tr -d '\r\n' < "$PGPASSWORD_FILE")"
  export PGPASSWORD
fi
databases=(${OPS_BACKUP_DATABASES:-company_ops keycloak})
retention="${OPS_BACKUP_RETENTION_DAYS:-14}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="/backup/${stamp}"
mkdir -p "$target"

started=$(date +%s)
{
  echo "created_utc=${stamp}"
  echo "server_version=$(psql -d company_ops -Atc 'show server_version')"
  echo "pg_dump_version=$(pg_dump --version)"
  echo "latest_migration=$(psql -d company_ops -Atc 'select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc limit 1')"
} > "$target/manifest.txt"

for db in "${databases[@]}"; do
  pg_dump --format=custom --compress=6 --no-password --dbname="$db" --file="$target/${db}.dump"
  pg_restore --list "$target/${db}.dump" > /dev/null
  echo "${db}_bytes=$(stat -c %s "$target/${db}.dump")" >> "$target/manifest.txt"
done

# Exact row counts of the application database, compared by the restore drill.
psql -d company_ops -At -F $'\t' > "$target/company_ops.counts.tsv" <<'SQL'
select format('select %L, count(*) from %I.%I', c.relname, n.nspname, c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by c.relname
\gexec
SQL

echo "duration_seconds=$(( $(date +%s) - started ))" >> "$target/manifest.txt"
(cd "$target" && sha256sum ./*.dump ./*.tsv manifest.txt > SHA256SUMS)
echo "backup ${stamp} written ($(du -sh "$target" | cut -f1)) in $(( $(date +%s) - started )) s" >&2

find /backup -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime "+${retention}" -print -exec rm -rf {} + >&2
