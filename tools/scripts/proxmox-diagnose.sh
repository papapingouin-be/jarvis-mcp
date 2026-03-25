#!/usr/bin/env bash
set -euo pipefail

PHASE=""
CONFIRMED="false"
declare -A PARAMS=()

log() {
  echo "[proxmox-diagnose] $*" >&2
}

json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

emit_error() {
  local summary="$1"
  local details="${2:-Operation failed}"
  printf '{"ok":false,"summary":"%s","details":"%s"}\n' \
    "$(json_escape "$summary")" \
    "$(json_escape "$details")"
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --phase)
        PHASE="${2:-}"
        shift 2
        ;;
      --confirmed)
        CONFIRMED="${2:-false}"
        shift 2
        ;;
      --param)
        local kv="${2:-}"
        local key="${kv%%=*}"
        local value="${kv#*=}"
        if [[ -z "$key" || "$key" == "$kv" ]]; then
          emit_error "Invalid parameter" "Expected --param key=value"
        fi
        PARAMS["$key"]="$value"
        shift 2
        ;;
      *)
        emit_error "Invalid argument" "Unknown argument: $1"
        ;;
    esac
  done

  if [[ "$PHASE" != "collect" && "$PHASE" != "execute" ]]; then
    emit_error "Invalid phase" "Expected collect or execute"
  fi
}

param_or_env() {
  local key="$1"
  local env_name="$2"
  local fallback="${3:-}"
  local value="${PARAMS[$key]:-}"

  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi

  value="${!env_name:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi

  printf '%s' "$fallback"
}

append_arg_if_value() {
  local -n target_ref="$1"
  local flag="$2"
  local value="$3"

  if [[ -n "$value" ]]; then
    target_ref+=("$flag" "$value")
  fi
}

append_bool_flag() {
  local -n target_ref="$1"
  local flag="$2"
  local value="${3:-false}"

  if [[ "$value" == "true" ]]; then
    target_ref+=("$flag")
  fi
}

resolve_mode() {
  local requested_mode="${PARAMS[mode]:-}"

  if [[ -n "$requested_mode" ]]; then
    printf '%s' "$requested_mode"
    return
  fi

  if [[ "$PHASE" == "collect" ]]; then
    printf 'collect'
    return
  fi

  emit_error "Missing required parameter" "mode is required for execute phase"
}

validate_mode_for_phase() {
  local mode="$1"

  case "$PHASE:$mode" in
    collect:self-doc|collect:diagnose|collect:collect|collect:preflight-create)
      return 0
      ;;
    execute:diagnose|execute:collect|execute:preflight-create|execute:create-ct|execute:get-ct-info|execute:stop-ct|execute:destroy-ct|execute:ensure-ct)
      return 0
      ;;
    *)
      emit_error "Unsupported mode for phase" "phase=$PHASE mode=$mode"
      ;;
  esac
}

build_core_args() {
  local mode="$1"
  local host user port password identity_file output
  host="$(param_or_env "host" "PROXMOX_HOST")"
  user="$(param_or_env "user" "PROXMOX_USER")"
  port="$(param_or_env "port" "PROXMOX_SSH_PORT" "22")"
  password="$(param_or_env "password" "PROXMOX_PASSWORD")"
  identity_file="$(param_or_env "identity_file" "PROXMOX_IDENTITY_FILE")"
  output="${PARAMS[output]:-json}"

  [[ -n "$host" ]] || emit_error "Missing target host" "Provide params.host or PROXMOX_HOST"
  [[ -n "$user" ]] || emit_error "Missing target user" "Provide params.user or PROXMOX_USER"

  local -a args=(
    "--host" "$host"
    "--port" "$port"
    "--user" "$user"
    "--mode" "$mode"
    "--output" "$output"
  )

  append_arg_if_value args "--password" "$password"
  append_arg_if_value args "--identity-file" "$identity_file"

  append_bool_flag args "--sudo" "${PARAMS[sudo]:-false}"
  append_bool_flag args "--verbose" "${PARAMS[verbose]:-false}"
  append_bool_flag args "--trace" "${PARAMS[trace]:-false}"
  append_bool_flag args "--install-ssh" "${PARAMS[install_ssh]:-false}"
  append_bool_flag args "--no-install-ssh" "${PARAMS[no_install_ssh]:-false}"
  append_bool_flag args "--reconfigure" "${PARAMS[reconfigure]:-false}"

  append_arg_if_value args "--type" "${PARAMS[type]:-}"
  append_arg_if_value args "--template" "${PARAMS[template]:-}"
  append_arg_if_value args "--storage" "${PARAMS[storage]:-}"
  append_arg_if_value args "--bridge" "${PARAMS[bridge]:-}"
  append_arg_if_value args "--vmid" "${PARAMS[vmid]:-}"
  append_arg_if_value args "--hostname" "${PARAMS[hostname]:-}"
  append_arg_if_value args "--cores" "${PARAMS[cores]:-}"
  append_arg_if_value args "--memory" "${PARAMS[memory]:-}"
  append_arg_if_value args "--swap" "${PARAMS[swap]:-}"
  append_arg_if_value args "--disk" "${PARAMS[disk]:-}"

  printf '%s\0' "${args[@]}"
}

main() {
  parse_args "$@"

  local mode
  mode="$(resolve_mode)"
  validate_mode_for_phase "$mode"

  if [[ "$PHASE" == "execute" && "$CONFIRMED" != "true" ]]; then
    emit_error "Execution requires confirmation" "Set confirmed=true"
  fi

  local script_dir core_script
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  core_script="$script_dir/proxmox-diagnose-core.sh"

  [[ -f "$core_script" ]] || emit_error "Missing core script" "Expected proxmox-diagnose-core.sh next to wrapper"

  local -a core_args=()
  while IFS= read -r -d '' item; do
    core_args+=("$item")
  done < <(build_core_args "$mode")

  log "Delegating to core script in mode=$mode"
  exec "$core_script" "${core_args[@]}"
}

main "$@"
