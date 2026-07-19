#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config

if gcloud_cmd compute instances describe "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" >/dev/null 2>&1; then
  if ! gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="make --directory=/opt/liveprobe/current DOCKER_COMPOSE='sudo docker compose' gcp-demo-down" \
    --quiet; then
    printf 'warning: could not stop Compose before deleting %s\n' "$VM_NAME" >&2
  fi
  gcloud_cmd compute instances delete "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --quiet
fi

for firewall_rule in "$FIREWALL_RULE" "$FIREWALL_SSH_RULE"; do
  if gcloud_cmd compute firewall-rules describe "$firewall_rule" \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud_cmd compute firewall-rules delete "$firewall_rule" \
      --project="$PROJECT_ID" \
      --quiet
  fi
done

if gcloud_cmd compute addresses describe "$STATIC_IP_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" >/dev/null 2>&1; then
  gcloud_cmd compute addresses delete "$STATIC_IP_NAME" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --quiet
fi

printf 'Deleted GCE demo resources for project %s in %s\n' \
  "$PROJECT_ID" "$ZONE"
