#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config
[[ -n "$HTTPS_DOMAIN" ]] || die "set HTTPS_DOMAIN to the broker hostname"

gcloud_cmd services enable \
  compute.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

if ! gcloud_cmd compute instances describe "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" >/dev/null 2>&1; then
  die "broker VM does not exist: ${VM_NAME}"
fi

if ! gcloud_cmd compute addresses describe "$HTTPS_IP_NAME" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute addresses create "$HTTPS_IP_NAME" \
    --project="$PROJECT_ID" \
    --global \
    --ip-version=IPV4 \
    --network-tier=PREMIUM \
    --quiet
fi
https_ip="$(
  gcloud_cmd compute addresses describe "$HTTPS_IP_NAME" \
    --project="$PROJECT_ID" \
    --global \
    --format='value(address)'
)"
validate_ipv4 "$https_ip"

if ! gcloud_cmd compute instance-groups unmanaged describe "$HTTPS_INSTANCE_GROUP" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" >/dev/null 2>&1; then
  gcloud_cmd compute instance-groups unmanaged create "$HTTPS_INSTANCE_GROUP" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --quiet
fi
if ! gcloud_cmd compute instance-groups unmanaged list-instances "$HTTPS_INSTANCE_GROUP" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --filter="instance.basename()=${VM_NAME}" \
  --format='value(instance)' | grep -q .; then
  gcloud_cmd compute instance-groups unmanaged add-instances "$HTTPS_INSTANCE_GROUP" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --instances="$VM_NAME" \
    --quiet
fi
gcloud_cmd compute instance-groups unmanaged set-named-ports "$HTTPS_INSTANCE_GROUP" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --named-ports="http:${BROKER_PORT}" \
  --quiet

if gcloud_cmd compute health-checks describe "$HTTPS_HEALTH_CHECK" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute health-checks update http "$HTTPS_HEALTH_CHECK" \
    --project="$PROJECT_ID" \
    --global \
    --port-name=http \
    --request-path=/healthz \
    --check-interval=10s \
    --timeout=5s \
    --healthy-threshold=2 \
    --unhealthy-threshold=3 \
    --quiet
else
  gcloud_cmd compute health-checks create http "$HTTPS_HEALTH_CHECK" \
    --project="$PROJECT_ID" \
    --global \
    --port-name=http \
    --request-path=/healthz \
    --check-interval=10s \
    --timeout=5s \
    --healthy-threshold=2 \
    --unhealthy-threshold=3 \
    --quiet
fi

if gcloud_cmd compute backend-services describe "$HTTPS_BACKEND_SERVICE" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute backend-services update "$HTTPS_BACKEND_SERVICE" \
    --project="$PROJECT_ID" \
    --global \
    --protocol=HTTP \
    --port-name=http \
    --health-checks="$HTTPS_HEALTH_CHECK" \
    --timeout=120s \
    --enable-logging \
    --logging-sample-rate=1.0 \
    --quiet
else
  gcloud_cmd compute backend-services create "$HTTPS_BACKEND_SERVICE" \
    --project="$PROJECT_ID" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --protocol=HTTP \
    --port-name=http \
    --health-checks="$HTTPS_HEALTH_CHECK" \
    --timeout=120s \
    --enable-logging \
    --logging-sample-rate=1.0 \
    --quiet
fi
if ! gcloud_cmd compute backend-services describe "$HTTPS_BACKEND_SERVICE" \
  --project="$PROJECT_ID" \
  --global \
  --format='value(backends.group)' | grep -q "/instanceGroups/${HTTPS_INSTANCE_GROUP}$"; then
  gcloud_cmd compute backend-services add-backend "$HTTPS_BACKEND_SERVICE" \
    --project="$PROJECT_ID" \
    --global \
    --instance-group="$HTTPS_INSTANCE_GROUP" \
    --instance-group-zone="$ZONE" \
    --balancing-mode=UTILIZATION \
    --max-utilization=0.8 \
    --quiet
fi

if gcloud_cmd compute firewall-rules describe "$HTTPS_FIREWALL_RULE" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud_cmd compute firewall-rules update "$HTTPS_FIREWALL_RULE" \
    --project="$PROJECT_ID" \
    --allow="tcp:${BROKER_PORT}" \
    --source-ranges="$HTTPS_PROXY_SOURCE_RANGES" \
    --target-tags="$NETWORK_TAG" \
    --quiet
else
  gcloud_cmd compute firewall-rules create "$HTTPS_FIREWALL_RULE" \
    --project="$PROJECT_ID" \
    --network="$NETWORK" \
    --direction=INGRESS \
    --priority=1000 \
    --action=ALLOW \
    --rules="tcp:${BROKER_PORT}" \
    --source-ranges="$HTTPS_PROXY_SOURCE_RANGES" \
    --target-tags="$NETWORK_TAG" \
    --quiet
fi

if gcloud_cmd compute url-maps describe "$HTTPS_URL_MAP" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute url-maps set-default-service "$HTTPS_URL_MAP" \
    --project="$PROJECT_ID" \
    --global \
    --default-service="$HTTPS_BACKEND_SERVICE" \
    --quiet
else
  gcloud_cmd compute url-maps create "$HTTPS_URL_MAP" \
    --project="$PROJECT_ID" \
    --global \
    --default-service="$HTTPS_BACKEND_SERVICE" \
    --quiet
fi

if ! gcloud_cmd compute ssl-certificates describe "$HTTPS_CERTIFICATE" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute ssl-certificates create "$HTTPS_CERTIFICATE" \
    --project="$PROJECT_ID" \
    --global \
    --domains="$HTTPS_DOMAIN" \
    --quiet
else
  certificate_domains="$(
    gcloud_cmd compute ssl-certificates describe "$HTTPS_CERTIFICATE" \
      --project="$PROJECT_ID" \
      --global \
      --format='value(managed.domains)'
  )"
  [[ "$certificate_domains" == "$HTTPS_DOMAIN" ]] ||
    die "existing certificate domain ${certificate_domains:-<empty>} does not match ${HTTPS_DOMAIN}"
fi

if ! gcloud_cmd compute ssl-policies describe "$HTTPS_SSL_POLICY" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute ssl-policies create "$HTTPS_SSL_POLICY" \
    --project="$PROJECT_ID" \
    --profile=MODERN \
    --min-tls-version=1.2 \
    --quiet
else
  gcloud_cmd compute ssl-policies update "$HTTPS_SSL_POLICY" \
    --project="$PROJECT_ID" \
    --global \
    --profile=MODERN \
    --min-tls-version=1.2 \
    --quiet
fi

if gcloud_cmd compute target-https-proxies describe "$HTTPS_PROXY" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute target-https-proxies update "$HTTPS_PROXY" \
    --project="$PROJECT_ID" \
    --global \
    --url-map="$HTTPS_URL_MAP" \
    --ssl-certificates="$HTTPS_CERTIFICATE" \
    --ssl-policy="$HTTPS_SSL_POLICY" \
    --quiet
else
  gcloud_cmd compute target-https-proxies create "$HTTPS_PROXY" \
    --project="$PROJECT_ID" \
    --global \
    --url-map="$HTTPS_URL_MAP" \
    --ssl-certificates="$HTTPS_CERTIFICATE" \
    --ssl-policy="$HTTPS_SSL_POLICY" \
    --quiet
fi

if ! gcloud_cmd compute forwarding-rules describe "$HTTPS_FORWARDING_RULE" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute forwarding-rules create "$HTTPS_FORWARDING_RULE" \
    --project="$PROJECT_ID" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --network-tier=PREMIUM \
    --address="$HTTPS_IP_NAME" \
    --target-https-proxy="$HTTPS_PROXY" \
    --ports=443 \
    --quiet
else
  gcloud_cmd compute forwarding-rules set-target "$HTTPS_FORWARDING_RULE" \
    --project="$PROJECT_ID" \
    --global \
    --target-https-proxy="$HTTPS_PROXY" \
    --quiet
fi

redirect_file="$(mktemp "${TMPDIR:-/tmp}/liveprobe-http-redirect.XXXXXX.yaml")"
trap 'rm -f -- "$redirect_file"' EXIT
cat >"$redirect_file" <<EOF
name: ${HTTP_REDIRECT_URL_MAP}
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: PERMANENT_REDIRECT
  stripQuery: false
EOF
gcloud_cmd compute url-maps import "$HTTP_REDIRECT_URL_MAP" \
  --project="$PROJECT_ID" \
  --global \
  --source="$redirect_file" \
  --quiet

if gcloud_cmd compute target-http-proxies describe "$HTTP_REDIRECT_PROXY" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute target-http-proxies update "$HTTP_REDIRECT_PROXY" \
    --project="$PROJECT_ID" \
    --global \
    --url-map="$HTTP_REDIRECT_URL_MAP" \
    --quiet
else
  gcloud_cmd compute target-http-proxies create "$HTTP_REDIRECT_PROXY" \
    --project="$PROJECT_ID" \
    --global \
    --url-map="$HTTP_REDIRECT_URL_MAP" \
    --quiet
fi
if ! gcloud_cmd compute forwarding-rules describe "$HTTP_REDIRECT_FORWARDING_RULE" \
  --project="$PROJECT_ID" \
  --global >/dev/null 2>&1; then
  gcloud_cmd compute forwarding-rules create "$HTTP_REDIRECT_FORWARDING_RULE" \
    --project="$PROJECT_ID" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --network-tier=PREMIUM \
    --address="$HTTPS_IP_NAME" \
    --target-http-proxy="$HTTP_REDIRECT_PROXY" \
    --ports=80 \
    --quiet
else
  gcloud_cmd compute forwarding-rules set-target "$HTTP_REDIRECT_FORWARDING_RULE" \
    --project="$PROJECT_ID" \
    --global \
    --target-http-proxy="$HTTP_REDIRECT_PROXY" \
    --quiet
fi

certificate_status="$(
  gcloud_cmd compute ssl-certificates describe "$HTTPS_CERTIFICATE" \
    --project="$PROJECT_ID" \
    --global \
    --format='value(managed.status)'
)"

printf 'HTTPS load balancer IP: %s\n' "$https_ip"
printf 'Required DNS record: %s A %s\n' "$HTTPS_DOMAIN" "$https_ip"
printf 'Certificate status: %s\n' "${certificate_status:-unknown}"
printf 'Keep direct HTTP available until the certificate status is ACTIVE.\n'
printf 'Then run HTTPS_DOMAIN=%q PROJECT_ID=%q deploy/gcp/activate-https.sh\n' \
  "$HTTPS_DOMAIN" "$PROJECT_ID"
