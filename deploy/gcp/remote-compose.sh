#!/usr/bin/env bash

set -Eeuo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || die "remote-compose.sh must run as root"
[[ -r /etc/liveprobe/deployment.env ]] ||
  die "deployment configuration is missing"

set -a
# shellcheck disable=SC1091
source /etc/liveprobe/deployment.env
set +a

action="${1:-}"
shift || true
target=""
make_args=()

case "$action" in
  status)
    (($# == 0)) || die "status does not accept arguments"
    target=gcp-demo-status
    ;;
  logs)
    tail_lines=200
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
        *) die "unknown logs argument: $1" ;;
      esac
    done
    [[ "$tail_lines" =~ ^[1-9][0-9]*$ ]] ||
      die "--tail must be a positive integer"
    log_args="--tail=${tail_lines}"
    if [[ "$follow" == true ]]; then
      log_args+=" --follow"
    fi
    make_args+=("GCP_LOGS_ARGS=${log_args}")
    target=gcp-demo-logs
    ;;
  down)
    (($# == 0)) || die "down does not accept arguments"
    target=gcp-demo-down
    ;;
  *) die "usage: remote-compose.sh status|logs|down" ;;
esac

make --directory=/opt/liveprobe/current \
  DOCKER_COMPOSE="docker compose" \
  GCP_DATABASE_BACKEND="$DATABASE_BACKEND" \
  GCP_ENV_FILE=/etc/liveprobe/deployment.env \
  "${make_args[@]}" \
  "$target"
