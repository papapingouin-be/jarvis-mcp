#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3000/mcp}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; exit 1; }

request() {
  local method="$1"
  local body="$2"
  local sid="${3:-}"
  local headers_file="$4"
  local body_file="$5"

  local -a curl_args=(
    -sS
    -D "$headers_file"
    -o "$body_file"
    -H 'content-type: application/json'
    -H 'accept: application/json, text/event-stream'
    -H 'MCP-Protocol-Version: 2024-11-05'
  )

  if [[ -n "$sid" ]]; then
    curl_args+=(
      -H "Mcp-Session-Id: $sid"
      -H "x-mcp-session-id: $sid"
    )
  fi

  curl_args+=( -X "$method" )

  if [[ -n "$body" ]]; then
    curl_args+=( -d "$body" )
  fi

  curl_args+=( "$BASE_URL" )

  curl "${curl_args[@]}"
}

http_status() {
  awk 'toupper($1) ~ /^HTTP\// {code=$2} END{print code}' "$1"
}

extract_sid() {
  local sid
  sid="$(awk 'BEGIN{IGNORECASE=1} /^Mcp-Session-Id:/{print $2}' "$1" | tr -d '\r')"
  if [[ -z "$sid" ]]; then
    sid="$(awk 'BEGIN{IGNORECASE=1} /^x-mcp-session-id:/{print $2}' "$1" | tr -d '\r')"
  fi
  printf '%s' "$sid"
}

echo "[1/3] initialize"
H1="$TMP_DIR/initialize.headers"
B1="$TMP_DIR/initialize.body"
request POST '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"session-smoke","version":"1.0"}}}' '' "$H1" "$B1"

S1="$(http_status "$H1")"
[[ "$S1" == "200" ]] || fail "initialize HTTP status expected 200, got $S1 (body: $(cat "$B1"))"
pass "initialize HTTP 200"

SID="$(extract_sid "$H1")"
[[ -n "$SID" ]] || fail "initialize did not return a session id header"
pass "session id returned: $SID"

echo "[2/3] notifications/initialized"
H2="$TMP_DIR/initialized.headers"
B2="$TMP_DIR/initialized.body"
request POST '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' "$SID" "$H2" "$B2"

S2="$(http_status "$H2")"
[[ "$S2" == "202" || "$S2" == "200" || "$S2" == "204" ]] || fail "initialized notification unexpected status $S2 (body: $(cat "$B2"))"
pass "notifications/initialized accepted ($S2)"

echo "[3/3] tools/list"
H3="$TMP_DIR/tools-list.headers"
B3="$TMP_DIR/tools-list.body"
request POST '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$SID" "$H3" "$B3"

S3="$(http_status "$H3")"
[[ "$S3" == "200" ]] || fail "tools/list HTTP status expected 200, got $S3 (body: $(cat "$B3"))"

grep -q '"result"' "$B3" || fail "tools/list response does not contain result"
grep -q '"tools"' "$B3" || fail "tools/list response does not contain tools"
pass "tools/list OK"

echo "All checks passed against $BASE_URL"
