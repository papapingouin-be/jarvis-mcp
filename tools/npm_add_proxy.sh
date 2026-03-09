#!/usr/bin/env sh
set -eu

# Backward-compat wrapper: npm_add_proxy.sh <domain> <forward_host> <forward_port>
exec "$(dirname "$0")/jarvis_npm.sh" add "${1:-}" "${2:-}" "${3:-}"
