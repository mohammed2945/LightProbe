#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

require_command curl
require_command dig
require_command node
[[ -n "${LIVEPROBE_API_KEY:-}" ]] ||
  die "set LIVEPROBE_API_KEY to verify authenticated broker access"

load_gcp_config
[[ -n "$HTTPS_DOMAIN" ]] || die "set HTTPS_DOMAIN to the broker hostname"
if ! source_range="$(resolve_client_source_range)"; then
  exit 1
fi

https_ip="$(
  gcloud_cmd compute addresses describe "$HTTPS_IP_NAME" \
    --project="$PROJECT_ID" \
    --global \
    --format='value(address)'
)"
validate_ipv4 "$https_ip"

resolved_addresses="$(dig +short A "$HTTPS_DOMAIN")"
if ! grep -Fx "$https_ip" <<<"$resolved_addresses" >/dev/null; then
  die "DNS for ${HTTPS_DOMAIN} does not resolve to ${https_ip}"
fi

certificate_status="$(
  gcloud_cmd compute ssl-certificates describe "$HTTPS_CERTIFICATE" \
    --project="$PROJECT_ID" \
    --global \
    --format='value(managed.status)'
)"
[[ "$certificate_status" == "ACTIVE" ]] ||
  die "managed certificate is ${certificate_status:-unknown}; wait for ACTIVE"

gcloud_cmd compute forwarding-rules describe "$HTTPS_FORWARDING_RULE" \
  --project="$PROJECT_ID" \
  --global >/dev/null

broker_url="https://${HTTPS_DOMAIN}"
curl --fail --silent --show-error "${broker_url}/healthz" >/dev/null
curl --fail --silent --show-error "${broker_url}/readyz" >/dev/null
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "${broker_url}/v1/ping" >/dev/null

PROJECT_ID="$PROJECT_ID" \
REGION="$REGION" \
ZONE="$ZONE" \
VM_NAME="$VM_NAME" \
FIREWALL_RULE="$FIREWALL_RULE" \
FIREWALL_SSH_RULE="$FIREWALL_SSH_RULE" \
HTTPS_FIREWALL_RULE="$HTTPS_FIREWALL_RULE" \
HTTPS_DOMAIN="$HTTPS_DOMAIN" \
NETWORK="$NETWORK" \
NETWORK_TAG="$NETWORK_TAG" \
BROKER_PORT="$BROKER_PORT" \
CLIENT_IP="" \
CLIENT_CIDR="$source_range" \
GCLOUD_BIN="$GCLOUD_BIN" \
  "${SCRIPT_DIR}/refresh-firewall.sh"

# Verify the load balancer still reaches the origin after direct ingress closes.
curl --fail --silent --show-error "${broker_url}/readyz" >/dev/null
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "${broker_url}/v1/ping" >/dev/null

gcloud_cmd compute instances add-metadata "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --metadata="${HTTPS_DOMAIN_METADATA_KEY}=${HTTPS_DOMAIN}" \
  --quiet

printf 'HTTPS is active: %s\n' "$broker_url"
printf 'Direct broker ingress is closed; SSH remains restricted to %s.\n' \
  "$source_range"
printf '\nExact Cursor MCP JSON:\n'
print_broker_mcp_json "$broker_url" "$LIVEPROBE_API_KEY"
