#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config

delete_global_compute_resource() {
  local resource_group="$1"
  local resource_name="$2"

  if gcloud_cmd compute "$resource_group" describe "$resource_name" \
    --project="$PROJECT_ID" \
    --global >/dev/null 2>&1; then
    gcloud_cmd compute "$resource_group" delete "$resource_name" \
      --project="$PROJECT_ID" \
      --global \
      --quiet
  fi
}

delete_global_compute_resource forwarding-rules "$HTTPS_FORWARDING_RULE"
delete_global_compute_resource forwarding-rules "$HTTP_REDIRECT_FORWARDING_RULE"
delete_global_compute_resource target-https-proxies "$HTTPS_PROXY"
delete_global_compute_resource target-http-proxies "$HTTP_REDIRECT_PROXY"
delete_global_compute_resource url-maps "$HTTPS_URL_MAP"
delete_global_compute_resource url-maps "$HTTP_REDIRECT_URL_MAP"
delete_global_compute_resource ssl-certificates "$HTTPS_CERTIFICATE"
delete_global_compute_resource ssl-policies "$HTTPS_SSL_POLICY"
delete_global_compute_resource backend-services "$HTTPS_BACKEND_SERVICE"
delete_global_compute_resource health-checks "$HTTPS_HEALTH_CHECK"

if gcloud_cmd compute instance-groups unmanaged describe "$HTTPS_INSTANCE_GROUP" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" >/dev/null 2>&1; then
  gcloud_cmd compute instance-groups unmanaged delete "$HTTPS_INSTANCE_GROUP" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --quiet
fi

if gcloud_cmd compute instances describe "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" >/dev/null 2>&1; then
  if ! gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="sudo /opt/liveprobe/current/deploy/gcp/remote-compose.sh down" \
    --quiet; then
    printf 'warning: could not stop Compose before deleting %s\n' "$VM_NAME" >&2
  fi
  gcloud_cmd compute instances delete "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --quiet
fi

for firewall_rule in \
  "$FIREWALL_RULE" \
  "$FIREWALL_SSH_RULE" \
  "$HTTPS_FIREWALL_RULE"; do
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

if gcloud_cmd compute addresses describe "$HTTPS_IP_NAME" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute addresses delete "$HTTPS_IP_NAME" \
    --project="$PROJECT_ID" \
    --global \
    --quiet
fi

printf 'Deleted GCE demo resources for project %s in %s\n' \
  "$PROJECT_ID" "$ZONE"
