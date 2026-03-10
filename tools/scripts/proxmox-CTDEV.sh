#!/usr/bin/env bash
set -euo pipefail

PHASE=""
CONFIRMED="false"
declare -A PARAMS=()

log() {
  echo "[proxmox-CTDEV] $*" >&2
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

emit_error() {
  local summary="$1"
  local details="${2:-Operation failed}"
  printf '{"ok":false,"summary":"%s","details":"%s"}\n' \
    "$(json_escape "$summary")" \
    "$(json_escape "$details")"
  exit 1
}

require_non_empty_env() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]]
}

check_required_env() {
  local -a required=(
    "PROXMOX_HOST"
    "PROXMOX_WEB"
    "PROXMOX_SSH_PORT"
    "PROXMOX_USER"
    "PROXMOX_PASSWORD"
    "PROXMOX_API_TOKEN_ID"
    "PROXMOX_API_TOKEN_SECRET"
  )

  local missing=""
  local env_name
  for env_name in "${required[@]}"; do
    if ! require_non_empty_env "$env_name"; then
      if [[ -n "$missing" ]]; then
        missing+=", "
      fi
      missing+="$env_name"
    fi
  done

  if [[ -n "$missing" ]]; then
    emit_error "Missing required environment variables" "$missing"
  fi
}

run_remote() {
  local remote_cmd="$1"
  local -a base_ssh=(
    ssh
    -p "$PROXMOX_SSH_PORT"
    -o BatchMode=no
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    "$PROXMOX_USER@$PROXMOX_HOST"
    "$remote_cmd"
  )

  if command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$PROXMOX_PASSWORD" "${base_ssh[@]}"
    return
  fi

  "${base_ssh[@]}"
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

collect_phase() {
  check_required_env

  log "Collecting Proxmox templates and CT inventory"

  local templates
  if ! templates="$(run_remote "pveam available --section system 2>/dev/null | awk 'NR>1 {print \$2}'")"; then
    emit_error "Failed to list Proxmox templates" "SSH/API access failed during collect"
  fi

  local ct_list
  if ! ct_list="$(run_remote "pct list 2>/dev/null | awk 'NR>1 {print \$1\":\"\$3\":\"\$4}'")"; then
    emit_error "Failed to list existing CTs" "SSH/API access failed during collect"
  fi

  local templates_json
  templates_json="$(json_array_from_lines "$templates")"
  local ct_json
  ct_json="$(json_array_from_lines "$ct_list")"

  local default_template
  default_template="$(printf '%s\n' "$templates" | head -n 1)"
  if [[ -z "$default_template" ]]; then
    default_template="debian-12-standard_12.7-1_amd64.tar.zst"
  fi

  printf '{"ok":true,"phase":"collect","summary":"Collect completed","proxmox":{"host":"%s","web":"%s","ssh_port":"%s"},"templates":%s,"existing_ct":%s,"proposed_defaults":{"vmid":"9100","hostname":"ctdev","template":"%s","cores":"2","memory":"2048","storage":"local-lvm","disk":"8","bridge":"vmbr0"},"next_action":"Call jarvis_run_script with phase=execute, confirmed=true, and chosen params"}\n' \
    "$(json_escape "$PROXMOX_HOST")" \
    "$(json_escape "$PROXMOX_WEB")" \
    "$(json_escape "$PROXMOX_SSH_PORT")" \
    "$templates_json" \
    "$ct_json" \
    "$(json_escape "$default_template")"
}

execute_phase() {
  check_required_env

  if [[ "$CONFIRMED" != "true" ]]; then
    emit_error "Execution requires confirmation" "Set confirmed=true"
  fi

  local vmid="${PARAMS[vmid]:-}"
  local template="${PARAMS[template]:-}"
  local hostname="${PARAMS[hostname]:-ctdev}"
  local cores="${PARAMS[cores]:-2}"
  local memory="${PARAMS[memory]:-2048}"
  local storage="${PARAMS[storage]:-local-lvm}"
  local disk="${PARAMS[disk]:-8}"
  local bridge="${PARAMS[bridge]:-vmbr0}"

  [[ -n "$vmid" ]] || emit_error "Missing required parameter" "vmid is required"
  [[ -n "$template" ]] || emit_error "Missing required parameter" "template is required"

  [[ "$vmid" =~ ^[0-9]+$ ]] || emit_error "Invalid vmid" "vmid must be numeric"
  [[ "$template" =~ ^[A-Za-z0-9._:-]+$ ]] || emit_error "Invalid template" "template contains unsupported characters"

  log "Checking template availability"
  run_remote "pveam available --section system 2>/dev/null | awk 'NR>1 {print \$2}' | grep -Fx -- '$template' >/dev/null" \
    || emit_error "Template not found" "Selected template is not available"

  log "Checking if CT already exists"
  if run_remote "pct status $vmid >/dev/null 2>&1"; then
    emit_error "CT already exists" "A container with this vmid already exists"
  fi

  log "Creating CT"
  run_remote "pct create $vmid local:vztmpl/$template --hostname $hostname --cores $cores --memory $memory --rootfs ${storage}:${disk} --net0 name=eth0,bridge=${bridge},ip=dhcp --unprivileged 1" \
    || emit_error "CT creation failed" "Proxmox pct create returned an error"

  log "Starting CT"
  run_remote "pct start $vmid" || emit_error "CT start failed" "Container was created but failed to start"

  printf '{"ok":true,"phase":"execute","status":"completed","summary":"CT dev created and started","details":{"vmid":"%s","hostname":"%s","template":"%s","cores":"%s","memory":"%s","storage":"%s","disk":"%s","bridge":"%s"},"next_steps":["Verify network connectivity in Proxmox","Harden container access before exposing services"]}\n' \
    "$(json_escape "$vmid")" \
    "$(json_escape "$hostname")" \
    "$(json_escape "$template")" \
    "$(json_escape "$cores")" \
    "$(json_escape "$memory")" \
    "$(json_escape "$storage")" \
    "$(json_escape "$disk")" \
    "$(json_escape "$bridge")"
}

parse_args "$@"

case "$PHASE" in
  collect)
    collect_phase
    ;;
  execute)
    execute_phase
    ;;
esac
