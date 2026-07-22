#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

require_command openssl
load_gcp_config
[[ "$SECRETS_BACKEND" == "secret-manager" ]] ||
  die "rotate-api-key.sh requires SECRETS_BACKEND=secret-manager"

action="${1:-}"
current_ring="$(read_secret_version "$LIVEPROBE_API_KEYS_SECRET")"
validate_api_key_ring "$current_ring"

case "$action" in
  begin)
    [[ "$current_ring" != *,* ]] ||
      die "rotation is already in progress; finish it before starting another"
    new_key="${LIVEPROBE_NEW_API_KEY:-$(openssl rand -hex 32)}"
    validate_api_key "$new_key"
    [[ "$new_key" != "$current_ring" ]] || die "new API key matches current key"
    next_ring="${new_key},${current_ring}"
    ;;
  finish)
    [[ "$current_ring" == *,* ]] || die "no API key rotation is in progress"
    new_key="${current_ring%%,*}"
    next_ring="$new_key"
    ;;
  *) die "usage: rotate-api-key.sh begin|finish" ;;
esac

printf '%s' "$next_ring" | gcloud_cmd secrets versions add \
  "$LIVEPROBE_API_KEYS_SECRET" \
  --project="$PROJECT_ID" \
  --data-file=- \
  --quiet >/dev/null

if [[ "$action" == "begin" ]]; then
  printf 'New API key: %s\n' "$new_key"
  printf 'Redeploy, update every client to the new key, then run finish and redeploy again.\n'
else
  printf 'Previous API key removed from the latest secret version. Redeploy now.\n'
fi
