#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -x "$ROOT/python/sdk/.venv/bin/python" ]; then
  PYTHON=$ROOT/python/sdk/.venv/bin/python
elif command -v python3.12 >/dev/null 2>&1; then
  PYTHON=$(command -v python3.12)
elif command -v python3 >/dev/null 2>&1; then
  PYTHON=$(command -v python3)
else
  echo "Python 3.12+ is required" >&2
  exit 127
fi

if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'; then
  VERSION=$("$PYTHON" --version 2>&1)
  echo "Python 3.12+ is required (found $VERSION)" >&2
  exit 1
fi

exec "$PYTHON" "$@"
