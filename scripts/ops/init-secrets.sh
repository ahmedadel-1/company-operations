#!/usr/bin/env bash
# Creates the secret files read by docker-compose.prod.yml (docs/runbooks/secrets.md). Run once per host
# as root, before the first `docker compose up`:
#
#   sudo bash scripts/ops/init-secrets.sh [secrets dir, default /etc/company-ops/secrets]
#
# Existing files are never overwritten (rotation is a separate, rehearsed procedure), and no secret value
# is printed. Secrets issued by an outside provider (S3 key, SMTP password, Jira/GitHub credentials) cannot
# be generated here; the script lists the ones still missing and exits non-zero until they exist.
#
# Permissions: the directory is root-only (0700), so no other host account can reach the files. Each file
# is 0444 because Compose bind-mounts it with its host mode into containers that run as unprivileged users
# (postgres and redis as 999, the Node images and Keycloak as 1000), and each container mounts only the
# secrets it needs.
#
# Optional environment: OPS_DB_HOST (default postgres), OPS_DB_PORT (5432), OPS_DB_NAME (company_ops),
# OPS_REDIS_HOST (redis), OPS_REDIS_PORT (6379); set them when using docker-compose.prod.external-data.yml.
set -euo pipefail

dir="${1:-/etc/company-ops/secrets}"
db_host="${OPS_DB_HOST:-postgres}"
db_port="${OPS_DB_PORT:-5432}"
db_name="${OPS_DB_NAME:-company_ops}"
redis_host="${OPS_REDIS_HOST:-redis}"
redis_port="${OPS_REDIS_PORT:-6379}"

if [ "$(id -u)" -ne 0 ]; then
  echo "init-secrets: run as root (the secrets directory must be root-owned)" >&2
  exit 1
fi

umask 077
mkdir -p "$dir"
chown root:root "$dir"
chmod 0700 "$dir"

random_hex() {
  # 24 random bytes as 48 hex characters: URL-safe, so it can be embedded in connection strings.
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

random_key() {
  # 32 random bytes, base64 (APP_ENCRYPTION_KEY format).
  head -c 32 /dev/urandom | base64 | tr -d '\n'
}

created=0
write_new() {
  local name="$1" value="$2" path="$dir/$1"
  if [ -e "$path" ]; then
    return 0
  fi
  printf '%s\n' "$value" > "$path.tmp"
  chmod 0444 "$path.tmp"
  mv "$path.tmp" "$path"
  created=$((created + 1))
  echo "created $name"
}

read_secret() {
  tr -d '\n' < "$dir/$1"
}

# Passwords first: the connection strings below embed them.
for name in postgres_superuser_password ops_app_db_password ops_migrator_db_password ops_backup_db_password \
  keycloak_db_password keycloak_admin_password redis_password oidc_client_secret; do
  write_new "$name" "$(random_hex)"
done
write_new app_encryption_key "$(random_key)"
# Retired encryption keys (<id>:<base64>, comma-separated); empty until the first rotation.
write_new app_encryption_keys_previous ""

write_new database_url "postgresql://ops_app:$(read_secret ops_app_db_password)@${db_host}:${db_port}/${db_name}"
write_new database_migration_url \
  "postgresql://ops_migrator:$(read_secret ops_migrator_db_password)@${db_host}:${db_port}/${db_name}"
write_new redis_url "redis://:$(read_secret redis_password)@${redis_host}:${redis_port}"

# Re-assert the permission model on every run (files created by hand included).
find "$dir" -maxdepth 1 -type f -exec chown root:root {} + -exec chmod 0444 {} +

missing=0
for name in s3_secret_access_key; do
  if [ ! -s "$dir/$name" ]; then
    echo "missing (required): $dir/$name - the object storage provider's secret access key" >&2
    missing=$((missing + 1))
  fi
done
echo "optional, only with the matching Compose overlay: smtp_password (docker-compose.prod.smtp.yml)," \
  "jira_oauth_client_secret (docker-compose.prod.jira.yml), github_app_private_key, github_app_client_secret," \
  "github_webhook_secret (docker-compose.prod.github.yml), private_ca.pem (docker-compose.prod.private-ca.yml)"
echo "init-secrets: $created file(s) created in $dir"
if [ "$missing" -gt 0 ]; then
  echo "init-secrets: write the missing provider secret(s) with: install -m 0444 /dev/stdin <path>" >&2
  exit 2
fi
