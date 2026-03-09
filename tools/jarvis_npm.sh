#!/usr/bin/env sh
set -eu

JARVIS_REQUIRED_SECRETS="NPM_URL NPM_IDENTITY NPM_SECRET"
# shellcheck disable=SC1091
. "$(dirname "$0")/../scripts/load_secrets.sh"

ACTION="${1:-help}"

usage() {
  cat <<'EOF'
jarvis_npm actions:
  help
  list [domain_filter]
  add <domain> <forward_host> <forward_port>
  delete <domain>

Required env (via secrets file): NPM_URL, NPM_IDENTITY, NPM_SECRET
EOF
}

require_script() {
  target="$1"
  if [ ! -x "$target" ]; then
    echo "Missing $target (mount it read-only in /opt/host-tools)" >&2
    exit 3
  fi
}

export NPM_URL NPM_IDENTITY NPM_SECRET

case "$ACTION" in
  help)
    usage
    ;;

  list)
    FILTER="${2:-}"
    if [ -x /opt/host-tools/npm_list_services.sh ]; then
      exec /opt/host-tools/npm_list_services.sh "$FILTER"
    fi

    if [ -x /opt/host-tools/npm_ls_services.sh ]; then
      exec /opt/host-tools/npm_ls_services.sh "$FILTER"
    fi

    echo "Missing list script: expected /opt/host-tools/npm_list_services.sh (or npm_ls_services.sh)" >&2
    exit 4
    ;;

  add)
    DOMAIN="${2:-}"
    FWD_HOST="${3:-}"
    FWD_PORT="${4:-}"

    if [ -z "$DOMAIN" ] || [ -z "$FWD_HOST" ] || [ -z "$FWD_PORT" ]; then
      echo "Usage: jarvis_npm.sh add <domain> <forward_host> <forward_port>" >&2
      exit 2
    fi

    require_script /opt/host-tools/npm_add_service.sh
    exec /opt/host-tools/npm_add_service.sh "$DOMAIN" "$FWD_HOST" "$FWD_PORT"
    ;;

  delete)
    DOMAIN="${2:-}"
    if [ -z "$DOMAIN" ]; then
      echo "Usage: jarvis_npm.sh delete <domain>" >&2
      exit 2
    fi

    if [ -x /opt/host-tools/npm_delete_service.sh ]; then
      exec /opt/host-tools/npm_delete_service.sh "$DOMAIN"
    fi

    if [ -x /opt/host-tools/npm_remove_service.sh ]; then
      exec /opt/host-tools/npm_remove_service.sh "$DOMAIN"
    fi

    echo "Missing delete script: expected /opt/host-tools/npm_delete_service.sh (or npm_remove_service.sh)" >&2
    exit 4
    ;;

  *)
    echo "Unknown action: $ACTION" >&2
    usage >&2
    exit 2
    ;;
esac
