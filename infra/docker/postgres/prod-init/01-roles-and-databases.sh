#!/usr/bin/env bash
# Production roles and databases (docs/DEPLOYMENT.md §6, docs/runbooks/database-roles.md).
# Runs once, on the first start of the bundled PostgreSQL with an empty data volume. For an external
# PostgreSQL, run the same statements as a superuser (or the provider's admin role) before the first
# migration.
#
#   ops_migrator  owns the schema; used only by the one-shot migrate job. No CREATEDB, no superuser.
#   ops_app       runtime role for API and worker: CONNECT, schema USAGE and table DML through default
#                 privileges. No CREATE on the schema, no TRUNCATE, no ownership, so it cannot create,
#                 alter or drop objects, create functions or disable the append-only audit triggers.
#   ops_backup    read-only role for pg_dump (pg_read_all_data); cannot write.
#   keycloak      owns the separate keycloak database.
#
# Passwords come from files (Docker secrets); a variable without _FILE is accepted for external tooling.
set -euo pipefail

secret() {
  local name="$1" file_var="${1}_FILE"
  if [[ -n "${!file_var:-}" ]]; then
    tr -d '\r\n' < "${!file_var}"
  elif [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
  else
    echo "missing ${name} or ${file_var}" >&2
    exit 1
  fi
}

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$(secret OPS_APP_DB_PASSWORD)" \
  -v migrator_password="$(secret OPS_MIGRATOR_DB_PASSWORD)" \
  -v backup_password="$(secret OPS_BACKUP_DB_PASSWORD)" \
  -v keycloak_password="$(secret KEYCLOAK_DB_PASSWORD)" <<'SQL'
CREATE ROLE ops_migrator LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD :'migrator_password';
CREATE ROLE ops_app LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD :'app_password';
CREATE ROLE ops_backup LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD :'backup_password';
CREATE DATABASE company_ops OWNER ops_migrator;
REVOKE ALL ON DATABASE company_ops FROM PUBLIC;
GRANT CONNECT ON DATABASE company_ops TO ops_app, ops_backup;
-- A transaction left open by a crashed request must not hold locks indefinitely.
ALTER ROLE ops_app SET idle_in_transaction_session_timeout = '5min';

CREATE ROLE keycloak LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD :'keycloak_password';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
GRANT CONNECT ON DATABASE keycloak TO ops_backup;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname company_ops <<'SQL'
ALTER SCHEMA public OWNER TO ops_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ops_app, ops_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE ops_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ops_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ops_app;
GRANT pg_read_all_data TO ops_backup;
SQL
