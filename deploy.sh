#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT in .env or the environment}"
: "${SUPABASE_URL:?Set SUPABASE_URL in .env or the environment}"
: "${SUPABASE_SERVICE_KEY:?Set SUPABASE_SERVICE_KEY in .env or the environment}"
GCP_REGION="${GCP_REGION:-us-central1}"

DEPLOYED_URL=""

deploy_service() {
  local logical_name="$1"
  local module="$2"
  local stack_id="$3"
  shift 3

  local cloud_name="riderush-${logical_name//_/-}-${stack_id//_/-}"
  local env_spec="^|^MODULE=${module}|SUPABASE_URL=${SUPABASE_URL}|SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}|STACK_ID=${stack_id}|PYTHONPATH=/app"
  local assignment
  for assignment in "$@"; do
    env_spec+="|${assignment}"
  done

  echo "Deploying ${cloud_name} (${module})"
  gcloud run deploy "$cloud_name" \
    --source . \
    --project "$GCP_PROJECT" \
    --region "$GCP_REGION" \
    --platform managed \
    --allow-unauthenticated \
    --min-instances=1 \
    --no-cpu-throttling \
    --timeout=300 \
    --cpu=1 \
    --memory=512Mi \
    --clear-base-image \
    --set-env-vars "$env_spec" \
    --quiet

  # Best-effort public invoker binding (may fail without IAM admin).
  gcloud run services add-iam-policy-binding "$cloud_name" \
    --project "$GCP_PROJECT" \
    --region "$GCP_REGION" \
    --member="allUsers" \
    --role="roles/run.invoker" \
    --quiet >/dev/null 2>&1 || true

  DEPLOYED_URL="$(
    gcloud run services describe "$cloud_name" \
      --project "$GCP_PROJECT" \
      --region "$GCP_REGION" \
      --format='value(status.url)' 2>/dev/null || true
  )"
  if [[ -z "$DEPLOYED_URL" ]]; then
    echo "FAILED ${cloud_name}" >&2
    exit 1
  fi
  echo "${cloud_name} -> ${DEPLOYED_URL}"
}

deploy_stack() {
  local stack_id="$1"
  local include_agent="$2"
  local pricing_url location_url payments_url matching_url trips_url
  local gateway_url world_url ridersim_url

  echo
  echo "=== Deploying stack ${stack_id} ==="

  deploy_service "pricing" "services.pricing.app" "$stack_id"
  pricing_url="$DEPLOYED_URL"

  deploy_service "location" "services.location.app" "$stack_id"
  location_url="$DEPLOYED_URL"

  deploy_service "payments" "services.payments.app" "$stack_id"
  payments_url="$DEPLOYED_URL"

  deploy_service \
    "matching" "services.matching.app" "$stack_id" \
    "LOCATION_URL=${location_url}"
  matching_url="$DEPLOYED_URL"

  deploy_service \
    "trips" "services.trips.app" "$stack_id" \
    "PAYMENTS_URL=${payments_url}"
  trips_url="$DEPLOYED_URL"

  deploy_service \
    "gateway" "services.gateway.app" "$stack_id" \
    "MATCHING_URL=${matching_url}" \
    "PRICING_URL=${pricing_url}" \
    "TRIPS_URL=${trips_url}"
  gateway_url="$DEPLOYED_URL"

  deploy_service \
    "world" "world.app" "$stack_id" \
    "LOCATION_URL=${location_url}" \
    "TRIPS_URL=${trips_url}" \
    "PAYMENTS_URL=${payments_url}"
  world_url="$DEPLOYED_URL"

  deploy_service \
    "ridersim" "services.ridersim.app" "$stack_id" \
    "GATEWAY_URL=${gateway_url}" \
    "LOCATION_URL=${location_url}"
  ridersim_url="$DEPLOYED_URL"

  if [[ "$include_agent" == "yes" ]]; then
    deploy_service \
      "liveprobe" "liveprobe.daemon" "$stack_id" \
      "GATEWAY_URL=${gateway_url}" \
      "MATCHING_URL=${matching_url}" \
      "PRICING_URL=${pricing_url}" \
      "LOCATION_URL=${location_url}" \
      "TRIPS_URL=${trips_url}" \
      "PAYMENTS_URL=${payments_url}" \
      "GEMINI_API_KEY=${GEMINI_API_KEY:-}" \
      "GEMINI_MODEL=${GEMINI_MODEL:-gemini-2.5-flash}"
  fi

  echo "Stack ${stack_id} deployed:"
  echo "  gateway=${gateway_url}"
  echo "  world=${world_url}"
  echo "  ridersim=${ridersim_url}"
  echo "ARENA_GATEWAY_URL=${gateway_url}"
}

# Fast path: arena first so we have a pasteable link ASAP, then the others.
deploy_stack "arena" "yes"
deploy_stack "gauntlet_a" "yes"
deploy_stack "gauntlet_b" "no"
