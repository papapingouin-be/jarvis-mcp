#!/usr/bin/env bash
set -Eeuo pipefail

# jarvis_sync_build_redeploy.sh
# Repo wrapper version: 1.2
# Role: compatibility wrapper only
# Canonical implementation: tools/scripts/jarvis_sync_build_redeploy.sh
# Use this file only if an older path still points to /app/tools/jarvis_sync_build_redeploy.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/scripts/jarvis_sync_build_redeploy.sh" "$@"
