#!/bin/sh
set -eu

case "${ENABLE_INTERNAL_JDWP:-false}" in
  true)
    case "${INTERNAL_JDWP_PORT:-5005}" in
      ''|*[!0-9]*)
        echo "INTERNAL_JDWP_PORT must be a positive integer" >&2
        exit 64
        ;;
    esac
    if [ "${INTERNAL_JDWP_PORT:-5005}" -le 0 ]; then
      echo "INTERNAL_JDWP_PORT must be a positive integer" >&2
      exit 64
    fi
    set -- "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${INTERNAL_JDWP_PORT:-5005}"
    ;;
  false)
    set --
    ;;
  *)
    echo "ENABLE_INTERNAL_JDWP must be true or false" >&2
    exit 64
    ;;
esac

# The image deliberately does not EXPOSE the diagnostic port. If enabled,
# attach only from another container on a Docker --internal network.
exec java "$@" -jar /app/inventory-service.jar
