#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config

public_ip="$(
  gcloud_cmd compute addresses describe "$STATIC_IP_NAME" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='value(address)'
)"
validate_ipv4 "$public_ip"

gcloud_cmd compute ssh "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --command="make --directory=/opt/liveprobe/current DOCKER_COMPOSE='sudo docker compose' gcp-demo-status && printf 'Deployed SHA: ' && cat /opt/liveprobe/current/.deploy-commit" \
  --quiet

printf 'Broker URL: http://%s:%s\n' "$public_ip" "$BROKER_PORT"
