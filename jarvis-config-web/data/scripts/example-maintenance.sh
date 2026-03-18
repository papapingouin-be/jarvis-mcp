#!/usr/bin/env bash
set -euo pipefail
PHASE=""
CONFIRMED=""
PARAMS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:-}"; shift 2 ;;
    --confirmed) CONFIRMED="${2:-}"; shift 2 ;;
    --param) PARAMS+=("${2:-}"); shift 2 ;;
    *) PARAMS+=("$1"); shift ;;
  esac
done
echo "example-maintenance.sh"
echo "phase=${PHASE}"
echo "confirmed=${CONFIRMED}"
printf 'params=%s
' "${PARAMS[*]:-}"
