#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config
load_persisted_https_domain

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
  --command="sudo /opt/liveprobe/current/deploy/gcp/remote-compose.sh status && printf 'Deployed SHA: ' && cat /opt/liveprobe/current/.deploy-commit" \
  --quiet

if [[ -n "$HTTPS_DOMAIN" ]]; then
  https_ip="$(
    gcloud_cmd compute addresses describe "$HTTPS_IP_NAME" \
      --project="$PROJECT_ID" \
      --global \
      --format='value(address)'
  )"
  certificate_status="$(
    gcloud_cmd compute ssl-certificates describe "$HTTPS_CERTIFICATE" \
      --project="$PROJECT_ID" \
      --global \
      --format='value(managed.status)'
  )"
  validate_ipv4 "$https_ip"
  printf 'Broker URL: https://%s\n' "$HTTPS_DOMAIN"
  printf 'HTTPS address: %s\n' "$https_ip"
  printf 'Managed certificate: %s\n' "${certificate_status:-unknown}"
else
  printf 'Broker URL: http://%s:%s\n' "$public_ip" "$BROKER_PORT"
fi
