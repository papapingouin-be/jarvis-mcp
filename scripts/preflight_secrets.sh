#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

# Ensure required runtime secrets are present.
JARVIS_REQUIRED_SECRETS="NPM_URL NPM_IDENTITY NPM_SECRET"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/load_secrets.sh"

echo "Secrets file loaded successfully: ${JARVIS_SECRETS_FILE:-$REPO_ROOT/.secrets/jarvis.env}"

LEAK_PATTERNS="M0nsieur7|jarvisadmin|P""AT|to""ken|pass""word|Authorization: Bea""rer|@webgit\\.|@github\\.com"

LEAKS=$(grep -RIn \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=.github \
  --exclude=secrets.example.env \
  --exclude=package-lock.json \
  --exclude=pnpm-lock.yaml \
  -E "$LEAK_PATTERNS" \
  "$REPO_ROOT" || true)

if [ -n "$LEAKS" ]; then
  echo "ERROR: potential secret leak patterns detected:" >&2
  echo "$LEAKS" >&2
  exit 1
fi

echo "Preflight secrets check: OK"
