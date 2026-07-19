#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for script in "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}"/lib/*.sh; do
  bash -n "$script"
  [[ -x "$script" ]] || fail "script is not executable: $script"
done

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}"/lib/*.sh
fi

if grep -R --exclude=test.sh -F '0.0.0.0/0' "${SCRIPT_DIR}" >/dev/null; then
  fail "deployment files must never allow 0.0.0.0/0"
fi

make_output="$(
  make --directory="$REPO_ROOT" --dry-run \
    DOCKER_COMPOSE='sudo docker compose' \
    gcp-demo-up
)"
grep -F \
  "sudo docker compose -f demo/docker-compose.yml -f deploy/gcp/docker-compose.gcp.yml" \
  <<<"$make_output" >/dev/null ||
  fail "GCP Make targets do not preserve DOCKER_COMPOSE"
grep -F 'pnpm --filter @liveprobe/sdk-node run build' \
  <<<"$make_output" >/dev/null ||
  fail "GCP prerequisites do not build the Node SDK"

# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
mcp_json="$(print_cursor_mcp_json 203.0.113.11 7070)"
node -e '
  const config = JSON.parse(process.argv[1]);
  const server = config.mcpServers?.liveprobe;
  const expected = [
    "-y",
    "@doomslayer2945/liveprobe-mcp@0.1.0",
    "--broker-url",
    "http://203.0.113.11:7070",
  ];
  if (server?.command !== "npx" ||
      JSON.stringify(server.args) !== JSON.stringify(expected)) {
    process.exit(1);
  }
' "$mcp_json" || fail "Cursor MCP JSON is invalid"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/liveprobe-gcp-test.XXXXXX")"
trap 'rm -rf -- "$tmp_dir"' EXIT
mock_gcloud="${tmp_dir}/gcloud"
mock_log="${tmp_dir}/gcloud.log"

cat >"$mock_gcloud" <<'MOCK'
#!/usr/bin/env bash
set -u
{
  printf 'CALL'
  for argument in "$@"; do
    printf ' <%s>' "$argument"
  done
  printf '\n'
} >>"${MOCK_GCLOUD_LOG:?}"

if [[ "${1:-} ${2:-} ${3:-}" == \
  "compute firewall-rules describe" ]]; then
  [[ "${MOCK_FIREWALL_EXISTS:-false}" == true ]] && exit 0
  exit 1
fi
MOCK
chmod +x "$mock_gcloud"

PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
STATIC_IP_NAME=lp-test-ip \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT=7070 \
CLIENT_IP=203.0.113.9 \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null

grep -F '<compute> <firewall-rules> <create> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "firewall create command was not constructed"
grep -F '<--source-ranges=203.0.113.9/32>' "$mock_log" >/dev/null ||
  fail "firewall source is not the current client /32"
[[ "$(grep -F -c '<--source-ranges=203.0.113.9/32>' "$mock_log")" -eq 2 ]] ||
  fail "broker and SSH firewall rules do not share the client /32"
grep -F '<--rules=tcp:7070>' "$mock_log" >/dev/null ||
  fail "firewall does not restrict the broker port"
grep -F '<--target-tags=liveprobe-demo>' "$mock_log" >/dev/null ||
  fail "firewall does not target the demo VM tag"
grep -F '<compute> <firewall-rules> <create> <lp-test-ssh>' \
  "$mock_log" >/dev/null ||
  fail "SSH firewall create command was not constructed"
grep -F '<--rules=tcp:22>' "$mock_log" >/dev/null ||
  fail "SSH firewall does not restrict access to tcp:22"

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
STATIC_IP_NAME=lp-test-ip \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT=7070 \
CLIENT_IP=203.0.113.10 \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_FIREWALL_EXISTS=true \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null

grep -F '<compute> <firewall-rules> <update> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "existing firewall rule was not updated"
grep -F '<--source-ranges=203.0.113.10/32>' "$mock_log" >/dev/null ||
  fail "firewall update did not replace the client /32"
[[ "$(grep -F -c '<--source-ranges=203.0.113.10/32>' "$mock_log")" -eq 2 ]] ||
  fail "firewall updates do not share the refreshed client /32"
grep -F '<--allow=tcp:7070>' "$mock_log" >/dev/null ||
  fail "firewall update did not preserve the broker-only rule"
grep -F '<compute> <firewall-rules> <update> <lp-test-ssh>' \
  "$mock_log" >/dev/null ||
  fail "existing SSH firewall rule was not updated"
grep -F '<--allow=tcp:22>' "$mock_log" >/dev/null ||
  fail "SSH firewall update did not preserve tcp:22 only"

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
STATIC_IP_NAME=lp-test-ip \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT=7070 \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_FIREWALL_EXISTS=true \
  "${SCRIPT_DIR}/destroy.sh" >/dev/null

grep -F '<compute> <firewall-rules> <delete> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "destroy did not delete the managed broker firewall"
grep -F '<compute> <firewall-rules> <delete> <lp-test-ssh>' \
  "$mock_log" >/dev/null ||
  fail "destroy did not delete the managed SSH firewall"
if grep -F 'default-allow-ssh' "$mock_log" >/dev/null; then
  fail "destroy attempted to modify an unrelated default firewall"
fi

: >"$mock_log"
if PROJECT_ID=lightprobe-test \
  FIREWALL_RULE=lp-test-broker \
  FIREWALL_SSH_RULE=default-allow-ssh \
  CLIENT_IP=203.0.113.9 \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null 2>&1; then
  fail "firewall refresh accepted an unrelated default rule name"
fi
[[ ! -s "$mock_log" ]] ||
  fail "firewall refresh touched gcloud after rejecting a default rule"

if PROJECT_ID=lightprobe-test \
  CLIENT_IP=0.0.0.0 \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null 2>&1; then
  fail "firewall refresh accepted 0.0.0.0 as a client address"
fi

printf 'GCP deployment tests passed\n'
