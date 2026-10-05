#!/usr/bin/env bash
# Restores a pg-backup.sh directory (docs/runbooks/backup-restore.md). Run as a PostgreSQL superuser (or
# the provider's admin role) on a server where the production roles exist (prod-init script):
#
#   pg-restore.sh <backup dir> [app database name] [keycloak database name]
#
# Defaults: company_ops_restore / keycloak_restore (new databases, so the live ones stay untouched until
# the operator swaps them). An existing *empty* database is reused (e.g. on a freshly initialized server).
# Objects are restored as ops_migrator / keycloak, so the default privileges give ops_app its DML grants.
# Fails on the first error, on a checksum mismatch or when a table's row count differs from the backup.
set -euo pipefail

dir="${1:?usage: pg-restore.sh <backup dir> [app db] [keycloak db]}"
app_db="${2:-company_ops_restore}"
kc_db="${3:-keycloak_restore}"
psql_admin=(psql -v ON_ERROR_STOP=1 -X -At --dbname=postgres)

(cd "$dir" && sha256sum --check --quiet SHA256SUMS)

ensure_db() {
  local db="$1" owner="$2"
  if [[ "$("${psql_admin[@]}" -c "select 1 from pg_database where datname = '${db}'")" != "1" ]]; then
    "${psql_admin[@]}" -c "create database \"${db}\" owner ${owner}"
    "${psql_admin[@]}" -c "revoke all on database \"${db}\" from public"
  elif [[ "$(psql -X -At --dbname="$db" -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")" != "0" ]]; then
    echo "database ${db} already contains tables; refusing to restore over it" >&2
    exit 1
  fi
}

started=$(date +%s)
ensure_db "$app_db" ops_migrator
"${psql_admin[@]}" -c "grant connect on database \"${app_db}\" to ops_app, ops_backup"
psql -v ON_ERROR_STOP=1 -X -q --dbname="$app_db" <<'SQL'
alter schema public owner to ops_migrator;
revoke all on schema public from public;
grant usage on schema public to ops_app, ops_backup;
alter default privileges for role ops_migrator in schema public grant select, insert, update, delete on tables to ops_app;
alter default privileges for role ops_migrator in schema public grant usage, select on sequences to ops_app;
SQL
pg_restore --exit-on-error --no-owner --no-acl --role=ops_migrator --dbname="$app_db" "$dir/company_ops.dump"
app_seconds=$(( $(date +%s) - started ))

mismatches=0
while IFS=$'\t' read -r table expected; do
  actual="$(psql -X -At --dbname="$app_db" -c "select count(*) from public.\"${table}\"")"
  if [[ "$actual" != "$expected" ]]; then
    echo "row count mismatch in ${table}: backup ${expected}, restored ${actual}" >&2
    mismatches=$(( mismatches + 1 ))
  fi
done < "$dir/company_ops.counts.tsv"
tables=$(wc -l < "$dir/company_ops.counts.tsv")
rows=$(awk -F '\t' '{ s += $2 } END { print s + 0 }' "$dir/company_ops.counts.tsv")
if (( mismatches > 0 )); then
  exit 1
fi
echo "restored ${app_db}: ${tables} tables, ${rows} rows, counts match, ${app_seconds} s"

if [[ -f "$dir/keycloak.dump" ]]; then
  kc_started=$(date +%s)
  ensure_db "$kc_db" keycloak
  "${psql_admin[@]}" -c "grant connect on database \"${kc_db}\" to ops_backup"
  pg_restore --exit-on-error --no-owner --no-acl --role=keycloak --dbname="$kc_db" "$dir/keycloak.dump"
  echo "restored ${kc_db}: $(psql -X -At --dbname="$kc_db" -c 'select count(*) from user_entity') identity users, $(( $(date +%s) - kc_started )) s"
fi
echo "restore_total_seconds=$(( $(date +%s) - started ))"
