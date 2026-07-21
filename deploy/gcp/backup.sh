#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
database_config="$(
  gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="sudo awk -F= '/^(DATABASE_BACKEND|CLOUD_SQL_INSTANCE_CONNECTION_NAME)=/ { print }' /etc/liveprobe/deployment.env" \
    --quiet
)"
active_database_backend=""
active_connection_name=""
while IFS='=' read -r key value; do
  case "$key" in
    DATABASE_BACKEND) active_database_backend="$value" ;;
    CLOUD_SQL_INSTANCE_CONNECTION_NAME) active_connection_name="$value" ;;
  esac
done <<<"$database_config"

case "$active_database_backend" in
  cloud-sql)
    [[ "$active_connection_name" == "${PROJECT_ID}:"*:* ]] ||
      die "invalid deployed Cloud SQL connection name"
    active_cloud_sql_instance="${active_connection_name##*:}"
    validate_resource_name "Cloud SQL instance name" "$active_cloud_sql_instance"
    gcloud_cmd sql backups create \
      --instance="$active_cloud_sql_instance" \
      --project="$PROJECT_ID" \
      --description="manual-${timestamp}" \
      --quiet
    printf 'Cloud SQL backup completed for %s\n' "$active_cloud_sql_instance"
    exit 0
    ;;
  local) ;;
  *) die "unknown deployed database backend: ${active_database_backend:-<empty>}" ;;
esac

backup_dir="${BACKUP_DIR:-${REPO_ROOT}/backups}"
backup_name="liveprobe-${timestamp}.dump"
remote_backup="/tmp/${backup_name}"
local_backup="${backup_dir}/${backup_name}"

install -d -m 0700 "$backup_dir"

cleanup_remote() {
  gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="rm -f -- '${remote_backup}'" \
    --quiet >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

printf -v remote_command \
  'set -Eeuo pipefail; container_id="$(sudo docker compose -f /opt/liveprobe/current/demo/docker-compose.yml -f /opt/liveprobe/current/deploy/gcp/docker-compose.gcp.yml ps -q postgres)"; test -n "$container_id"; sudo docker exec "$container_id" pg_dump --username=liveprobe --dbname=liveprobe --format=custom > %q; test -s %q' \
  "$remote_backup" \
  "$remote_backup"

gcloud_cmd compute ssh "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --command="$remote_command" \
  --quiet
gcloud_cmd compute scp \
  "${VM_NAME}:${remote_backup}" \
  "$local_backup" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --quiet

[[ -s "$local_backup" ]] || die "backup is empty: ${local_backup}"
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$local_backup" >/dev/null
fi

chmod 0600 "$local_backup"
printf 'Postgres backup: %s\n' "$local_backup"
