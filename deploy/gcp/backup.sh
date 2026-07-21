#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config

backup_dir="${BACKUP_DIR:-${REPO_ROOT}/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
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
