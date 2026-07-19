#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

tail_lines="${TAIL_LINES:-200}"
follow=false

while (($# > 0)); do
  case "$1" in
    --follow)
      follow=true
      shift
      ;;
    --tail)
      (($# >= 2)) || die "--tail requires a line count"
      tail_lines="$2"
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$tail_lines" =~ ^[1-9][0-9]*$ ]] ||
  die "TAIL_LINES must be a positive integer"

load_gcp_config

log_args="--tail=${tail_lines}"
if [[ "$follow" == true ]]; then
  log_args+=" --follow"
fi

printf -v remote_command \
  'make --directory=%q DOCKER_COMPOSE=%q GCP_LOGS_ARGS=%q gcp-demo-logs' \
  /opt/liveprobe/current \
  'sudo docker compose' \
  "$log_args"
gcloud_cmd compute ssh "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --command="$remote_command" \
  --quiet
