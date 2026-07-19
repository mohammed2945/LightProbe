#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required for the TypeScript redaction fixtures" >&2
  exit 127
fi

echo "==> TypeScript serializer fixtures"
pnpm --filter @liveprobe/sdk-node exec vitest run test/serializer.test.ts

echo "==> Python serializer fixtures"
if ! sh scripts/python312.sh -c 'import pytest' >/dev/null 2>&1; then
  echo "pytest is required for the Python redaction fixtures" >&2
  exit 1
fi
(cd python/sdk && sh ../../scripts/python312.sh -m pytest tests/test_serializer.py)

if ! command -v javac >/dev/null 2>&1 || ! command -v java >/dev/null 2>&1; then
  echo "SKIP Java redaction fixtures (JDK 17+ is unavailable)"
  exit 0
fi

JAVA_MAJOR=$(javac -version 2>&1 | awk '{
  split($2, version, ".");
  if (version[1] == "1") print version[2]; else print version[1]
}')
if [ "$JAVA_MAJOR" -lt 17 ]; then
  echo "SKIP Java redaction fixtures (JDK 17+ required; found javac $JAVA_MAJOR)"
  exit 0
fi

echo "==> Java serializer fixtures"
make -C java/bridge test
