#!/usr/bin/env bash
set -Eeuo pipefail

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

param_or_default() {
  local key="$1"
  local fallback="${2:-}"
  local value="${PARAMS[$key]:-}"

  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi

  printf '%s' "$fallback"
}

is_metadata_mode() {
  local mode="$1"
  case "$mode" in
    registry-doc|list-services|describe-service|validate-service-input)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

service_phase() {
  case "$1" in
    self-doc|diagnose|collect)
      printf 'collect'
      ;;
    preflight-create|create-ct|get-ct-info|stop-ct|destroy-ct|ensure-ct)
      printf 'execute'
      ;;
    *)
      return 1
      ;;
  esac
}

service_confirmed_required() {
  case "$1" in
    self-doc|diagnose|collect)
      printf 'false'
      ;;
    preflight-create|create-ct|get-ct-info|stop-ct|destroy-ct|ensure-ct)
      printf 'true'
      ;;
    *)
      return 1
      ;;
  esac
}

service_description() {
  case "$1" in
    self-doc) printf 'Return machine-readable documentation for the script.' ;;
    diagnose) printf 'Test SSH, remote context, sudo, and Proxmox commands.' ;;
    collect) printf 'Collect templates, storages, bridges, CTs, VMs, and nextid.' ;;
    preflight-create) printf 'Validate whether a future CT creation looks ready.' ;;
    create-ct) printf 'Create and start a CT container.' ;;
    get-ct-info) printf 'Read status, hostname, config, and IP of a CT.' ;;
    stop-ct) printf 'Stop an existing CT.' ;;
    destroy-ct) printf 'Destroy an existing CT.' ;;
    ensure-ct) printf 'Ensure a CT exists and is running.' ;;
    *)
      return 1
      ;;
  esac
}

service_required_params() {
  case "$1" in
    self-doc)
      ;;
    diagnose|collect)
      printf '%s\n' host user
      ;;
    preflight-create)
      printf '%s\n' host user type template storage bridge vmid hostname
      ;;
    create-ct|ensure-ct)
      printf '%s\n' host user password type template storage bridge vmid hostname
      ;;
    get-ct-info|stop-ct|destroy-ct)
      printf '%s\n' host user vmid
      ;;
    *)
      return 1
      ;;
  esac
}

service_optional_params() {
  case "$1" in
    self-doc)
      ;;
    diagnose|collect)
      printf '%s\n' password port sudo verbose trace identity_file
      ;;
    preflight-create)
      printf '%s\n' password port sudo verbose trace identity_file cores memory swap disk install_ssh
      ;;
    create-ct|ensure-ct)
      printf '%s\n' port sudo verbose trace identity_file cores memory swap disk install_ssh reconfigure
      ;;
    get-ct-info|stop-ct|destroy-ct)
      printf '%s\n' password port sudo verbose trace identity_file
      ;;
    *)
      return 1
      ;;
  esac
}

service_defaults_json() {
  case "$1" in
    diagnose|collect)
      printf '{"port":"22","sudo":true}'
      ;;
    preflight-create)
      printf '{"port":"22","sudo":true,"type":"ct","cores":"2","memory":"2048","disk":"8","install_ssh":true}'
      ;;
    create-ct|ensure-ct)
      printf '{"port":"22","sudo":true,"type":"ct","cores":"2","memory":"2048","swap":"512","disk":"8","install_ssh":true}'
      ;;
    get-ct-info|stop-ct|destroy-ct)
      printf '{"port":"22","sudo":true}'
      ;;
    self-doc)
      printf '{}'
      ;;
    *)
      return 1
      ;;
  esac
}

service_example_params_json() {
  case "$1" in
    self-doc)
      printf '{"mode":"self-doc"}'
      ;;
    diagnose)
      printf '{"mode":"diagnose","host":"192.168.11.248","user":"root","password":"change-me","sudo":true}'
      ;;
    collect)
      printf '{"mode":"collect","host":"192.168.11.248","user":"root","password":"change-me","sudo":true}'
      ;;
    preflight-create)
      printf '{"mode":"preflight-create","host":"192.168.11.248","user":"root","password":"change-me","sudo":true,"type":"ct","template":"debian-12-standard_12.7-1_amd64.tar.zst","storage":"local-lvm","bridge":"vmbr0","vmid":"9100","hostname":"ctdev","cores":"2","memory":"2048","disk":"8","install_ssh":true}'
      ;;
    create-ct)
      printf '{"mode":"create-ct","host":"192.168.11.248","user":"root","password":"change-me","sudo":true,"type":"ct","template":"debian-12-standard_12.7-1_amd64.tar.zst","storage":"local-lvm","bridge":"vmbr0","vmid":"9100","hostname":"ctdev","cores":"2","memory":"2048","disk":"8","install_ssh":true}'
      ;;
    get-ct-info)
      printf '{"mode":"get-ct-info","host":"192.168.11.248","user":"root","password":"change-me","sudo":true,"vmid":"9100"}'
      ;;
    stop-ct)
      printf '{"mode":"stop-ct","host":"192.168.11.248","user":"root","password":"change-me","sudo":true,"vmid":"9100"}'
      ;;
    destroy-ct)
      printf '{"mode":"destroy-ct","host":"192.168.11.248","user":"root","password":"change-me","sudo":true,"vmid":"9100"}'
      ;;
    ensure-ct)
      printf '{"mode":"ensure-ct","host":"192.168.11.248","user":"root","password":"change-me","sudo":true,"type":"ct","template":"debian-12-standard_12.7-1_amd64.tar.zst","storage":"local-lvm","bridge":"vmbr0","vmid":"9100","hostname":"ctdev","cores":"2","memory":"2048","disk":"8","install_ssh":true}'
      ;;
    *)
      return 1
      ;;
  esac
}

json_array_from_lines() {
  local lines="$1"
  local output="["
  local first=1

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ $first -eq 0 ]]; then
      output+=","
    fi
    output+="\"$(json_escape "$line")\""
    first=0
  done <<< "$lines"

  output+="]"
  printf '%s' "$output"
}

metadata_services_json() {
  local services="self-doc
diagnose
collect
preflight-create
create-ct
get-ct-info
stop-ct
destroy-ct
ensure-ct"
  local output="["
  local first=1
  local service

  while IFS= read -r service; do
    [[ -z "$service" ]] && continue
    if [[ $first -eq 0 ]]; then
      output+=","
    fi
    output+="$(service_schema_json "$service" short)"
    first=0
  done <<< "$services"

  output+="]"
  printf '%s' "$output"
}

registry_required_env_json() {
  printf '%s' '[
    {"name":"PROXMOX_HOST","required":false,"secret":false,"description":"Default Proxmox host when params.host is omitted."},
    {"name":"PROXMOX_USER","required":false,"secret":false,"description":"Default SSH user when params.user is omitted."},
    {"name":"PROXMOX_SSH_PORT","required":false,"secret":false,"description":"Default SSH port when params.port is omitted."},
    {"name":"PROXMOX_PASSWORD","required":false,"secret":true,"description":"Optional SSH password when key-based auth is not used."},
    {"name":"PROXMOX_IDENTITY_FILE","required":false,"secret":false,"description":"Optional SSH identity file path."}
  ]'
}

registry_doc_json() {
  local file_name
  file_name="$(basename "${BASH_SOURCE[0]}")"

  printf '{"ok":true,"mode":"registry-doc","script":{"script_name":"%s","file_name":"%s","description":"%s","version":"%s","required_env":%s,"supports_registry":true,"services":%s,"capabilities":["diagnose","collect","preflight-create","create-ct","get-ct-info","stop-ct","destroy-ct","ensure-ct","metadata"],"tags":["proxmox","ssh","container","vm","jarvis"]}}\n' \
    "$(json_escape "$file_name")" \
    "$(json_escape "$file_name")" \
    "$(json_escape "Diagnostic and orchestration wrapper for Proxmox over SSH.")" \
    "1.0.0" \
    "$(registry_required_env_json)" \
    "$(metadata_services_json)"
}

service_schema_json() {
  local service="$1"
  local mode="${2:-full}"
  local phase description confirmed required_json optional_json defaults_json example_json
  phase="$(service_phase "$service")" || emit_error "Unknown service" "service=$service"
  description="$(service_description "$service")"
  confirmed="$(service_confirmed_required "$service")"
  required_json="$(json_array_from_lines "$(service_required_params "$service")")"
  optional_json="$(json_array_from_lines "$(service_optional_params "$service")")"
  defaults_json="$(service_defaults_json "$service")"
  example_json="$(service_example_params_json "$service")"

  if [[ "$mode" == "short" ]]; then
    printf '{"name":"%s","phase":"%s","confirmed_required":%s,"description":"%s"}' \
      "$(json_escape "$service")" \
      "$(json_escape "$phase")" \
      "$confirmed" \
      "$(json_escape "$description")"
    return
  fi

  printf '{"name":"%s","phase":"%s","confirmed_required":%s,"description":"%s","required_params":%s,"optional_params":%s,"defaults":%s,"example_params":%s}' \
    "$(json_escape "$service")" \
    "$(json_escape "$phase")" \
    "$confirmed" \
    "$(json_escape "$description")" \
    "$required_json" \
    "$optional_json" \
    "$defaults_json" \
    "$example_json"
}

validate_service_input_json() {
  local service="$1"
  local phase confirmed required_json optional_json defaults_json example_json
  phase="$(service_phase "$service")" || emit_error "Unknown service" "service=$service"
  confirmed="$(service_confirmed_required "$service")"
  required_json="$(json_array_from_lines "$(service_required_params "$service")")"
  optional_json="$(json_array_from_lines "$(service_optional_params "$service")")"
  defaults_json="$(service_defaults_json "$service")"
  example_json="$(service_example_params_json "$service")"

  SERVICE_NAME="$service" \
  SERVICE_PHASE="$phase" \
  SERVICE_CONFIRMED="$confirmed" \
  SERVICE_REQUIRED_JSON="$required_json" \
  SERVICE_OPTIONAL_JSON="$optional_json" \
  SERVICE_DEFAULTS_JSON="$defaults_json" \
  SERVICE_EXAMPLE_JSON="$example_json" \
  PARAMS_JSON="$(params_json_for_validation)" \
  python3 - <<'PY'
import json
import os
import sys

service = os.environ["SERVICE_NAME"]
phase = os.environ["SERVICE_PHASE"]
confirmed = os.environ["SERVICE_CONFIRMED"].lower() == "true"
required_params = json.loads(os.environ["SERVICE_REQUIRED_JSON"])
optional_params = json.loads(os.environ["SERVICE_OPTIONAL_JSON"])
defaults = json.loads(os.environ["SERVICE_DEFAULTS_JSON"])
example_params = json.loads(os.environ["SERVICE_EXAMPLE_JSON"])
params = json.loads(os.environ["PARAMS_JSON"])

ignored = {"mode", "service", "output"}
known = {k: v for k, v in params.items() if k not in ignored and v not in ("", None)}
missing_required = [key for key in required_params if key not in known]
optional_missing = [key for key in optional_params if key not in known]

payload = {
    "ok": True,
    "mode": "validate-service-input",
    "service": service,
    "phase": phase,
    "confirmed_required": confirmed,
    "known": known,
    "missing_required": missing_required,
    "optional_missing": optional_missing,
    "defaults": defaults,
    "example_params": example_params,
    "ready": len(missing_required) == 0,
    "summary": "Service input is complete." if len(missing_required) == 0 else "Service input is missing required fields.",
}
sys.stdout.write(json.dumps(payload, separators=(",", ":")))
PY
}

params_json_for_validation() {
  local first=1
  local output="{"
  local key value

  for key in "${!PARAMS[@]}"; do
    value="${PARAMS[$key]}"
    if [[ $first -eq 0 ]]; then
      output+=","
    fi
    output+="\"$(json_escape "$key")\":\"$(json_escape "$value")\""
    first=0
  done

  output+="}"
  printf '%s' "$output"
}

handle_metadata_mode() {
  local mode="$1"
  local service="${PARAMS[service]:-}"

  case "$mode" in
    registry-doc)
      registry_doc_json
      ;;
    list-services)
      printf '{"ok":true,"mode":"list-services","services":%s,"summary":"Service catalog returned successfully."}\n' \
        "$(metadata_services_json)"
      ;;
    describe-service)
      [[ -n "$service" ]] || emit_error "Missing required parameter" "service is required"
      printf '{"ok":true,"mode":"describe-service","service":%s,"summary":"Service description returned successfully."}\n' \
        "$(service_schema_json "$service")"
      ;;
    validate-service-input)
      [[ -n "$service" ]] || emit_error "Missing required parameter" "service is required"
      validate_service_input_json "$service"
      printf '\n'
      ;;
    *)
      emit_error "Unsupported metadata mode" "mode=$mode"
      ;;
  esac
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
    collect:registry-doc|collect:list-services|collect:describe-service|collect:validate-service-input|collect:self-doc|collect:diagnose|collect:collect|collect:preflight-create)
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
  local host user port password identity_file output sudo_enabled
  host="$(param_or_env "host" "PROXMOX_HOST")"
  user="$(param_or_env "user" "PROXMOX_USER")"
  port="$(param_or_env "port" "PROXMOX_SSH_PORT" "22")"
  password="$(param_or_env "password" "PROXMOX_PASSWORD")"
  identity_file="$(param_or_env "identity_file" "PROXMOX_IDENTITY_FILE")"
  output="${PARAMS[output]:-json}"
  sudo_enabled="$(param_or_default "sudo" "true")"

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

  append_bool_flag args "--sudo" "$sudo_enabled"
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

  if is_metadata_mode "$mode"; then
    handle_metadata_mode "$mode"
    exit 0
  fi

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
