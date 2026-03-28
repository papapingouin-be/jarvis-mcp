#!/usr/bin/env bash
set -Eeuo pipefail

json_escape() {
  local value="${1:-}"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

die() {
  local summary="$1"
  local details="${2:-Operation failed}"
  printf '{"ok":false,"summary":"%s","details":"%s"}\n' \
    "$(json_escape "$summary")" \
    "$(json_escape "$details")"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command" "Command not found: $1"
}

need_cmd git

SRC_URL="${SRC_URL:-}"
DST_URL="${DST_URL:-}"
MODE="${MODE:-refs}"

[[ -n "$SRC_URL" ]] || die "Missing SRC_URL" "Provide SRC_URL in the environment"
[[ -n "$DST_URL" ]] || die "Missing DST_URL" "Provide DST_URL in the environment"

if [[ "$MODE" != "refs" ]]; then
  die "Unsupported MODE" "Only MODE=refs is supported"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

REPO_DIR="$TMP_DIR/repo.git"

git init --bare "$REPO_DIR" >/dev/null 2>&1
git -C "$REPO_DIR" remote add source "$SRC_URL"
git -C "$REPO_DIR" remote add destination "$DST_URL"

git -C "$REPO_DIR" fetch --prune --prune-tags source "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*"
git -C "$REPO_DIR" push --prune destination "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*"

printf '{"ok":true,"summary":"Git refs mirrored successfully.","details":"Mirror completed from source to destination.","mode":"%s"}\n' \
  "$(json_escape "$MODE")"
