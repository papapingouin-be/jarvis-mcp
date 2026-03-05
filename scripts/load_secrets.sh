#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

DEFAULT_SECRETS_FILE="$REPO_ROOT/.secrets/jarvis.env"
SECRETS_FILE="${JARVIS_SECRETS_FILE:-$DEFAULT_SECRETS_FILE}"
REQUIRED_KEYS="${JARVIS_REQUIRED_SECRETS:-NPM_URL NPM_IDENTITY NPM_SECRET}"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "ERROR: secrets file not found: $SECRETS_FILE" >&2
  echo "Create it from secrets.example.env and set JARVIS_SECRETS_FILE if needed." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

MISSING=""
for key in $REQUIRED_KEYS; do
  [ -z "$key" ] && continue
  eval "value=\${$key-}"
  if [ -z "${value}" ]; then
    MISSING="$MISSING $key"
  fi
done

if [ -n "$MISSING" ]; then
  echo "ERROR: missing required entries in $SECRETS_FILE:$MISSING" >&2
  exit 1
fi
