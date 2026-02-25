#!/usr/bin/env sh
set -eu

# Expected env vars:
# NPM_URL, NPM_IDENTITY, NPM_SECRET
# Args: domain forward_host forward_port
DOMAIN="${1:-}"
FWD_HOST="${2:-}"
FWD_PORT="${3:-}"

if [ -z "$DOMAIN" ] || [ -z "$FWD_HOST" ] || [ -z "$FWD_PORT" ]; then
  echo "Usage: npm_add_proxy.sh <domain> <forward_host> <forward_port>" >&2
  exit 2
fi

if [ ! -x /opt/host-tools/npm_add_service.sh ]; then
  echo "Missing /opt/host-tools/npm_add_service.sh (mount it read-only)" >&2
  exit 3
fi

export NPM_URL="${NPM_URL:-}"
export NPM_IDENTITY="${NPM_IDENTITY:-}"
export NPM_SECRET="${NPM_SECRET:-}"

exec /opt/host-tools/npm_add_service.sh "$DOMAIN" "$FWD_HOST" "$FWD_PORT"
