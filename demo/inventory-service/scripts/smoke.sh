#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEMO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
JAVA=${JAVA:-java}
MVN=${MVN:-mvn}
CURL=${CURL:-curl}
PORT=${PORT:-18080}
BASE_URL="http://127.0.0.1:$PORT"
JAR="$DEMO_DIR/target/inventory-service.jar"
LOG_FILE="$DEMO_DIR/target/smoke.log"
APP_PID=

cleanup() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ ! -f "$JAR" ]; then
  command -v "$MVN" >/dev/null 2>&1 || {
    echo "mvn is required to build the smoke-test jar" >&2
    exit 1
  }
  (cd "$DEMO_DIR" && "$MVN" --batch-mode --no-transfer-progress package)
fi

command -v "$JAVA" >/dev/null 2>&1 || {
  echo "java is required" >&2
  exit 1
}
command -v "$CURL" >/dev/null 2>&1 || {
  echo "curl is required" >&2
  exit 1
}

BUG=on PORT="$PORT" "$JAVA" -jar "$JAR" >"$LOG_FILE" 2>&1 &
APP_PID=$!

healthy=0
attempt=0
while [ "$attempt" -lt 80 ]; do
  if "$CURL" -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    echo "inventory service exited during startup; log follows" >&2
    awk '{ print }' "$LOG_FILE" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done

if [ "$healthy" -ne 1 ]; then
  echo "inventory service did not become healthy; log follows" >&2
  awk '{ print }' "$LOG_FILE" >&2
  exit 1
fi

before=$("$CURL" -fsS "$BASE_URL/stats")
TARGET_URL="$BASE_URL" WAVES=6 INTERVAL_MS=10 "$JAVA" \
  -cp "$JAR" io.liveprobe.demo.inventory.TrafficGenerator
after=$("$CURL" -fsS "$BASE_URL/stats")

json_number() {
  key=$1
  payload=$2
  printf '%s\n' "$payload" | awk -v token="\"$key\":" '
    {
      start = index($0, token)
      if (start == 0) {
        exit 1
      }
      rest = substr($0, start + length(token))
      if (match(rest, /^[0-9]+/)) {
        print substr(rest, RSTART, RLENGTH)
        exit 0
      }
      exit 1
    }
  '
}

before_completed=$(json_number completedRequests "$before")
after_completed=$(json_number completedRequests "$after")
before_wrong=$(json_number wrongStockDecisions "$before")
after_wrong=$(json_number wrongStockDecisions "$after")

if [ "$after_completed" -lt $((before_completed + 12)) ]; then
  echo "reservation counter did not advance by 12 requests" >&2
  exit 1
fi
if [ "$after_wrong" -lt $((before_wrong + 6)) ]; then
  echo "BUG=on did not record one stale-cache decision per wave" >&2
  exit 1
fi

echo "inventory smoke passed: completedRequests $before_completed -> $after_completed; wrongStockDecisions $before_wrong -> $after_wrong"
