#!/usr/bin/env bash
set -euo pipefail

JARVIS_REQUIRED_SECRETS=""
# shellcheck disable=SC1091
. "$(dirname "$0")/load_secrets.sh"

BASE_URL="${1:-http://localhost:3000/mcp}"

echo "[1/4] initialize -> $BASE_URL"
INIT_HEADERS=$(mktemp)
INIT_BODY=$(mktemp)

curl -sS -D "$INIT_HEADERS" -o "$INIT_BODY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  "$BASE_URL"

SID=$(awk 'BEGIN{IGNORECASE=1} /^Mcp-Session-Id:/{print $2}' "$INIT_HEADERS" | tr -d '\r')
if [ -z "$SID" ]; then
  SID=$(awk 'BEGIN{IGNORECASE=1} /^x-mcp-session-id:/{print $2}' "$INIT_HEADERS" | tr -d '\r')
fi

if [ -z "$SID" ]; then
  echo "ERROR: no session id returned"
  cat "$INIT_HEADERS"
  exit 1
fi

echo "SID=$SID"

echo "[2/4] notifications/initialized"
curl -sS -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" -H "x-mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  "$BASE_URL" > /dev/null

echo "[3/4] tools/list"
TOOLS=$(curl -sS -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" -H "x-mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "$BASE_URL")

echo "$TOOLS"
printf '%s' "$TOOLS" | grep -q '"echo"'
printf '%s' "$TOOLS" | grep -q '"jarvis_npm"'
printf '%s' "$TOOLS" | grep -q '"diagnose"'

echo "[4/4] tools/call diagnose"
DIAG=$(curl -sS -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" -H "x-mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"diagnose","arguments":{}}}' \
  "$BASE_URL")

echo "$DIAG"
printf '%s' "$DIAG" | grep -q 'ok'

echo "Smoke test: OK"

