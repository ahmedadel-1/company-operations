#!/usr/bin/env bash
# Runs once, on first initialisation of an empty data volume (postgres image entrypoint).
# Roles follow docs/DEPLOYMENT.md §6: ops_migrator owns the schema (Prisma migrations),
# ops_app has DML only. Keycloak gets its own role and database.
# Development/test only: ops_migrator has CREATEDB so `prisma migrate dev` can create its temporary
# shadow database. Production runs `prisma migrate deploy`, which needs no shadow database.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$OPS_APP_DB_PASSWORD" \
  -v migrator_password="$OPS_MIGRATOR_DB_PASSWORD" \
  -v keycloak_password="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE ops_migrator LOGIN CREATEDB PASSWORD :'migrator_password';
CREATE ROLE ops_app LOGIN PASSWORD :'app_password';
CREATE DATABASE company_ops OWNER ops_migrator;
REVOKE ALL ON DATABASE company_ops FROM PUBLIC;
GRANT CONNECT ON DATABASE company_ops TO ops_app;

CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_password';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname company_ops <<'SQL'
ALTER SCHEMA public OWNER TO ops_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ops_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ops_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ops_app;
SQL
