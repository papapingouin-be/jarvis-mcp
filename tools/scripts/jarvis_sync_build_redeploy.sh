#!/usr/bin/env bash
set -Eeuo pipefail

########################################
# jarvis_sync_build_redeploy.sh
# Repo script version: 1.4.4
# Role: canonical implementation used by registry/config-web/runtime
# Legacy wrapper path kept for compatibility: tools/jarvis_sync_build_redeploy.sh
#
# Workflow version: Jarvis V5.12
# Sync GitHub -> Build local -> Deploy web code -> Deploy scripts
# -> Mirror Gitea -> Portainer webhook -> Restart MCPO
#
# Improvements over V5.6:
# - deploy tools/scripts to a shared runtime scripts directory
# - verify/fix remote permissions
# - secret-safe logs
# - MCP-ready summary
########################################

########################################
# Globals
########################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Keep the default env file alongside legacy tool wrappers in /app/tools.
ENV_FILE_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)/.env"
LOG_DIR_DEFAULT="$SCRIPT_DIR/logs"
SUMMARY_DIR_DEFAULT="$SCRIPT_DIR/logs"

ENV_FILE_EXPLICIT=0
if [[ -n "${ENV_FILE:-}" ]]; then
  ENV_FILE_EXPLICIT=1
fi
ENV_FILE="${ENV_FILE:-$ENV_FILE_DEFAULT}"
LOG_DIR="${LOG_DIR:-$LOG_DIR_DEFAULT}"
SUMMARY_DIR="${SUMMARY_DIR:-$SUMMARY_DIR_DEFAULT}"

RUN_ID="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/jarvis_sync_${RUN_ID}.log"
SUMMARY_JSON="${SUMMARY_DIR}/jarvis_sync_${RUN_ID}.json"
LAST_SUMMARY_JSON=""
LOG_TO_FILE=1

DRY_RUN=0
PHASE="all"
JSON_STDOUT=0
ORIGINAL_STDOUT_FD=3
MCP_PHASE=""
MCP_CONFIRMED="false"
MCP_MODE=""
declare -A MCP_PARAMS=()

exec 3>&1

CURRENT_STEP=""
CURRENT_STEP_STATUS="pending"
CURRENT_STEP_INDEX=0
TOTAL_STEPS=0
STEP_SEQUENCE=()
CURRENT_SUBSTEP_INDEX=0
CURRENT_SUBSTEP_TOTAL=0

EXIT_OK=0
EXIT_ENV=10
EXIT_GIT=20
EXIT_NPM_INSTALL=30
EXIT_NPM_BUILD=31
EXIT_DEPLOY_WEB=40
EXIT_DEPLOY_SCRIPTS=41
EXIT_MIRROR=50
EXIT_WEBHOOK=60
EXIT_DOCKER=70
EXIT_UNKNOWN=99

SSH_AUTH_MODE="unknown"

########################################
# CLI args
########################################

usage() {
  cat <<EOF
Usage:
  $(basename "$0") [options]

Options:
  --env FILE           Fichier .env à utiliser
  --dry-run            Simulation sans exécuter
  --phase NAME         Phase unique:
                       all | sync | install | build | deploy-web | deploy-scripts | mirror | webhook | restart
  --json-stdout        Affiche le résumé JSON final sur stdout
  --help               Affiche cette aide

Exemples:
  $(basename "$0")
  $(basename "$0") --dry-run
  $(basename "$0") --phase deploy-scripts
  $(basename "$0") --json-stdout
EOF
}

json_escape_shell() {
  local value="${1:-}"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

emit_mcp_json() {
  printf '%s\n' "$1" >&${ORIGINAL_STDOUT_FD}
}

emit_mcp_error() {
  local summary="$1"
  local details="${2:-Operation failed}"
  local mode="${3:-unknown}"
  emit_mcp_json "$(printf '{"ok":false,"mode":"%s","summary":"%s","details":"%s"}' \
    "$(json_escape_shell "$mode")" \
    "$(json_escape_shell "$summary")" \
    "$(json_escape_shell "$details")")"
  exit 1
}

normalize_bool() {
  local value="${1:-false}"
  case "$value" in
    true|TRUE|1|yes|YES|on|ON)
      printf 'true'
      ;;
    false|FALSE|0|no|NO|off|OFF|'')
      printf 'false'
      ;;
    *)
      emit_mcp_error "Invalid boolean value" "Unsupported boolean value: ${value}" "${MCP_MODE:-argument-parse}"
      ;;
  esac
}

legacy_phase_to_mcp_phase() {
  case "$1" in
    self-doc|registry-doc|list-services|describe-service|validate-service-input)
      printf 'collect'
      ;;
    *)
      printf 'execute'
      ;;
  esac
}

mode_description() {
  case "$1" in
    self-doc) printf 'Return machine-readable documentation for the redeploy workflow script.' ;;
    registry-doc) printf 'Return registry metadata for the redeploy workflow script.' ;;
    list-services) printf 'List the services/actions published by the redeploy workflow script.' ;;
    describe-service) printf 'Describe one service/action exposed by the redeploy workflow script.' ;;
    validate-service-input) printf 'Validate params JSON and environment for one redeploy service.' ;;
    all) printf 'Run the full workflow: sync, install, build, deploy, mirror, webhook, restart.' ;;
    sync) printf 'Synchronize the local repository from GitHub.' ;;
    install) printf 'Install npm dependencies in the local repository.' ;;
    build) printf 'Build the local repository.' ;;
    deploy-web) printf 'Deploy web code to the remote host.' ;;
    deploy-scripts) printf 'Deploy runtime scripts to the shared scripts directory.' ;;
    mirror) printf 'Mirror GitHub refs to Gitea.' ;;
    webhook) printf 'Trigger the Portainer webhook.' ;;
    restart) printf 'Restart the MCPO container.' ;;
    *)
      return 1
      ;;
  esac
}

service_phase() {
  legacy_phase_to_mcp_phase "$1"
}

service_confirmed_required() {
  case "$1" in
    self-doc|registry-doc|list-services|describe-service|validate-service-input)
      printf 'false'
      ;;
    *)
      printf 'true'
      ;;
  esac
}

is_metadata_mode() {
  case "$1" in
    self-doc|registry-doc|list-services|describe-service|validate-service-input)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

service_required_params() {
  case "$1" in
    self-doc|registry-doc|list-services)
      ;;
    describe-service|validate-service-input)
      printf '%s\n' service
      ;;
    all|sync|install|build|deploy-web|deploy-scripts|mirror|webhook|restart)
      ;;
    *)
      return 1
      ;;
  esac
}

service_optional_params() {
  case "$1" in
    validate-service-input|all|sync|install|build|deploy-web|deploy-scripts|mirror|webhook|restart)
      printf '%s\n' dry_run env_file
      ;;
    self-doc|registry-doc|list-services|describe-service)
      ;;
    *)
      return 1
      ;;
  esac
}

service_required_env() {
  case "$1" in
    all)
      printf '%s\n' JARVIS_LOCAL_REPO JARVIS_srv_SSH JARVIS_srv_USER
      ;;
    sync|install|build)
      printf '%s\n' JARVIS_LOCAL_REPO
      ;;
    deploy-web|deploy-scripts)
      printf '%s\n' JARVIS_LOCAL_REPO JARVIS_srv_SSH JARVIS_srv_USER
      ;;
    mirror)
      ;;
    webhook|restart)
      ;;
    self-doc|registry-doc|list-services|describe-service|validate-service-input)
      ;;
    *)
      return 1
      ;;
  esac
}

service_optional_env() {
  case "$1" in
    all|sync|mirror)
      printf '%s\n' jarvis_tools_GITHUB_TOKEN jarvis_tools_GITEA_TOKEN
      ;;
    webhook)
      printf '%s\n' JARVIS_TOOLS_WEBHOOK_URL jarvis_tools_PORTAINER_URL jarvis_tools_PORTAINER_USER jarvis_tools_PORTAINER_PASSWORD PORTAINER_ENDPOINT_ID JARVIS_TOOLS_STACK_NAME
      ;;
    restart)
      printf '%s\n' JARVIS_MCPO_CONTAINER_NAME
      ;;
    deploy-web|deploy-scripts)
      printf '%s\n' JARVIS_SSH_KEY_PATH JARVIS_srv_PSWD
      ;;
    validate-service-input|self-doc|registry-doc|list-services|describe-service|install|build|webhook)
      ;;
    *)
      return 1
      ;;
  esac
}

service_defaults_json() {
  case "$1" in
    validate-service-input|all|sync|install|build|deploy-web|deploy-scripts|mirror|webhook|restart)
      printf '{"dry_run":false}'
      ;;
    self-doc|registry-doc|list-services|describe-service)
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
    registry-doc)
      printf '{"mode":"registry-doc"}'
      ;;
    list-services)
      printf '{"mode":"list-services"}'
      ;;
    describe-service)
      printf '{"mode":"describe-service","service":"all"}'
      ;;
    validate-service-input)
      printf '{"mode":"validate-service-input","service":"deploy-web","dry_run":true}'
      ;;
    all|sync|install|build|deploy-web|deploy-scripts|mirror|webhook|restart)
      printf '{"mode":"%s","dry_run":true}' "$1"
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
    [[ -n "$line" ]] || continue
    if [[ $first -eq 0 ]]; then
      output+=","
    fi
    output+="\"$(json_escape_shell "$line")\""
    first=0
  done <<< "$lines"

  output+="]"
  printf '%s' "$output"
}

service_schema_json() {
  local service="$1"
  local mode="${2:-full}"
  local phase description confirmed required_json optional_json required_env_json optional_env_json defaults_json example_json

  phase="$(service_phase "$service")" || emit_mcp_error "Unknown service" "service=${service}" "describe-service"
  description="$(mode_description "$service")"
  confirmed="$(service_confirmed_required "$service")"
  required_json="$(json_array_from_lines "$(service_required_params "$service")")"
  optional_json="$(json_array_from_lines "$(service_optional_params "$service")")"
  required_env_json="$(json_array_from_lines "$(service_required_env "$service")")"
  optional_env_json="$(json_array_from_lines "$(service_optional_env "$service")")"
  defaults_json="$(service_defaults_json "$service")"
  example_json="$(service_example_params_json "$service")"

  if [[ "$mode" == "short" ]]; then
    printf '{"name":"%s","phase":"%s","confirmed_required":%s,"description":"%s"}' \
      "$(json_escape_shell "$service")" \
      "$(json_escape_shell "$phase")" \
      "$confirmed" \
      "$(json_escape_shell "$description")"
    return
  fi

  printf '{"name":"%s","phase":"%s","confirmed_required":%s,"description":"%s","required_params":%s,"optional_params":%s,"required_env":%s,"optional_env":%s,"defaults":%s,"example_params":%s}' \
    "$(json_escape_shell "$service")" \
    "$(json_escape_shell "$phase")" \
    "$confirmed" \
    "$(json_escape_shell "$description")" \
    "$required_json" \
    "$optional_json" \
    "$required_env_json" \
    "$optional_env_json" \
    "$defaults_json" \
    "$example_json"
}

metadata_services_json() {
  local services="self-doc
registry-doc
list-services
describe-service
validate-service-input
all
sync
install
build
deploy-web
deploy-scripts
mirror
webhook
restart"
  local output="["
  local first=1
  local service

  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    if [[ $first -eq 0 ]]; then
      output+=","
    fi
    output+="$(service_schema_json "$service" short)"
    first=0
  done <<< "$services"

  output+="]"
  printf '%s' "$output"
}

validate_service_input_json() {
  local service="$1"
  local required_params optional_params required_env optional_env defaults_json example_json
  local known_output="{" known_first=1
  local env_output="{" env_first=1
  local missing_required_lines="" optional_missing_lines="" missing_env_lines="" optional_env_missing_lines=""
  local key value

  required_params="$(service_required_params "$service")"
  optional_params="$(service_optional_params "$service")"
  required_env="$(service_required_env "$service")"
  optional_env="$(service_optional_env "$service")"
  defaults_json="$(service_defaults_json "$service")"
  example_json="$(service_example_params_json "$service")"

  for key in "${!MCP_PARAMS[@]}"; do
    [[ "$key" != "mode" && "$key" != "service" ]] || continue
    value="${MCP_PARAMS[$key]}"
    [[ -n "$value" ]] || continue
    if [[ $known_first -eq 0 ]]; then
      known_output+=","
    fi
    known_output+="\"$(json_escape_shell "$key")\":\"$(json_escape_shell "$value")\""
    known_first=0
  done
  known_output+="}"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    [[ -n "${MCP_PARAMS[$key]:-}" ]] || missing_required_lines+="${key}"$'\n'
  done <<< "$required_params"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    [[ -n "${MCP_PARAMS[$key]:-}" ]] || optional_missing_lines+="${key}"$'\n'
  done <<< "$optional_params"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    value="${!key:-}"
    if [[ $env_first -eq 0 ]]; then
      env_output+=","
    fi
    env_output+="\"$(json_escape_shell "$key")\":"
    if [[ -n "$value" ]]; then
      env_output+="\"present\""
    else
      env_output+="\"missing\""
      missing_env_lines+="${key}"$'\n'
    fi
    env_first=0
  done <<< "$required_env"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    value="${!key:-}"
    if [[ $env_first -eq 0 ]]; then
      env_output+=","
    fi
    env_output+="\"$(json_escape_shell "$key")\":"
    if [[ -n "$value" ]]; then
      env_output+="\"present\""
    else
      env_output+="\"missing\""
      optional_env_missing_lines+="${key}"$'\n'
    fi
    env_first=0
  done <<< "$optional_env"
  env_output+="}"

  printf '{"ok":true,"mode":"validate-service-input","service":"%s","phase":"%s","confirmed_required":%s,"known":%s,"missing_required":%s,"optional_missing":%s,"env_status":%s,"missing_env":%s,"optional_env_missing":%s,"defaults":%s,"example_params":%s,"ready":%s,"summary":"%s"}' \
    "$(json_escape_shell "$service")" \
    "$(json_escape_shell "$(service_phase "$service")")" \
    "$(service_confirmed_required "$service")" \
    "$known_output" \
    "$(json_array_from_lines "$missing_required_lines")" \
    "$(json_array_from_lines "$optional_missing_lines")" \
    "$env_output" \
    "$(json_array_from_lines "$missing_env_lines")" \
    "$(json_array_from_lines "$optional_env_missing_lines")" \
    "$defaults_json" \
    "$example_json" \
    "$([[ -z "$missing_required_lines" && -z "$missing_env_lines" ]] && printf 'true' || printf 'false')" \
    "$(json_escape_shell "$([[ -z "$missing_required_lines" && -z "$missing_env_lines" ]] && printf 'Service input and environment look ready.' || printf 'Service input or environment is incomplete.')")"
}

handle_metadata_mode() {
  local mode="$1"
  local service="${MCP_PARAMS[service]:-}"

  case "$mode" in
    self-doc)
      self_doc_json
      ;;
    registry-doc)
      registry_doc_json
      ;;
    list-services)
      emit_mcp_json "$(printf '{"ok":true,"mode":"list-services","services":%s,"summary":"Service catalog returned successfully."}' "$(metadata_services_json)")"
      ;;
    describe-service)
      [[ -n "$service" ]] || emit_mcp_error "Missing parameter" "Expected --param service=..." "describe-service"
      emit_mcp_json "$(printf '{"ok":true,"mode":"describe-service","service":%s,"summary":"Service description returned successfully."}' "$(service_schema_json "$service")")"
      ;;
    validate-service-input)
      [[ -n "$service" ]] || emit_mcp_error "Missing parameter" "Expected --param service=..." "validate-service-input"
      emit_mcp_json "$(validate_service_input_json "$service")"
      ;;
    *)
      emit_mcp_error "Unsupported mode" "Unknown metadata mode: ${mode}" "$mode"
      ;;
  esac
}

self_doc_json() {
  local file_name
  file_name="$(basename "${BASH_SOURCE[0]}")"
  emit_mcp_json "$(printf '{
  "ok":true,
  "mode":"self-doc",
  "script":{
    "script_name":"%s",
    "file_name":"%s",
    "description":"%s",
      "version":"1.4.4",
    "supports_registry":true,
    "required_env":[
      {"name":"jarvis_tools_GITHUB_TOKEN","required":false,"secret":true,"description":"GitHub token used for sync and mirror."},
      {"name":"jarvis_tools_GITEA_TOKEN","required":false,"secret":true,"description":"Gitea token used for mirror."},
      {"name":"JARVIS_LOCAL_REPO","required":false,"secret":false,"description":"Local repository path."},
      {"name":"JARVIS_TOOLS_WEBHOOK_URL","required":false,"secret":true,"description":"Portainer webhook URL."},
      {"name":"JARVIS_MCPO_CONTAINER_NAME","required":false,"secret":false,"description":"MCPO container name."},
      {"name":"JARVIS_srv_SSH","required":false,"secret":false,"description":"SSH host and port for deploy target."},
      {"name":"JARVIS_srv_USER","required":false,"secret":false,"description":"SSH user for deploy target."},
      {"name":"JARVIS_SSH_KEY_PATH","required":false,"secret":false,"description":"Optional SSH private key path for deploy target authentication."},
      {"name":"JARVIS_srv_PSWD","required":false,"secret":true,"description":"Optional SSH password used when sshpass authentication is preferred."}
    ],
    "services":%s,
    "capabilities":["git-sync","npm-install","build","deploy-web","deploy-scripts","mirror","webhook","docker-restart"],
    "tags":["jarvis","deploy","build","mcp","automation"]
  },
  "runtime":{
    "accepted_phase_values":["collect","execute"],
    "accepted_params":["mode","service","dry_run","env_file"],
    "legacy_options":["--phase","--dry-run","--env","--json-stdout"]
  },
  "summary":"Jarvis sync/build/redeploy workflow self-documentation"
}' \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "Synchronize source, build locally, deploy web code and scripts, mirror refs, redeploy the Portainer stack or trigger a webhook, and restart MCPO.")" \
    "$(metadata_services_json)")"
}

registry_doc_json() {
  local file_name
  file_name="$(basename "${BASH_SOURCE[0]}")"
  emit_mcp_json "$(printf '{"ok":true,"mode":"registry-doc","script":{"script_name":"%s","file_name":"%s","description":"%s","version":"1.4.4","required_env":[{"name":"jarvis_tools_GITHUB_TOKEN","required":false,"secret":true,"description":"GitHub token used for sync and mirror."},{"name":"jarvis_tools_GITEA_TOKEN","required":false,"secret":true,"description":"Gitea token used for mirror."},{"name":"JARVIS_LOCAL_REPO","required":false,"secret":false,"description":"Local repository path."},{"name":"JARVIS_TOOLS_WEBHOOK_URL","required":false,"secret":true,"description":"Portainer webhook URL."},{"name":"jarvis_tools_PORTAINER_URL","required":false,"secret":false,"description":"Portainer base URL used for direct stack redeploy."},{"name":"jarvis_tools_PORTAINER_USER","required":false,"secret":false,"description":"Portainer username used for direct stack redeploy."},{"name":"jarvis_tools_PORTAINER_PASSWORD","required":false,"secret":true,"description":"Portainer password used for direct stack redeploy."},{"name":"PORTAINER_ENDPOINT_ID","required":false,"secret":false,"description":"Portainer endpoint id for the jarvis-tools stack redeploy."},{"name":"JARVIS_TOOLS_STACK_NAME","required":false,"secret":false,"description":"Portainer stack name for the jarvis-tools redeploy."},{"name":"JARVIS_TOOLS_CONTAINER_NAME","required":false,"secret":false,"description":"Container name expected to restart when the jarvis-tools stack is redeployed."},{"name":"PORTAINER_REDEPLOY_WAIT_SECONDS","required":false,"secret":false,"description":"Maximum wait time used to confirm the jarvis-tools container was really restarted."},{"name":"JARVIS_MCPO_CONTAINER_NAME","required":false,"secret":false,"description":"MCPO container name."},{"name":"JARVIS_srv_SSH","required":false,"secret":false,"description":"SSH host and port for deploy target."},{"name":"JARVIS_srv_USER","required":false,"secret":false,"description":"SSH user for deploy target."},{"name":"JARVIS_SSH_KEY_PATH","required":false,"secret":false,"description":"Optional SSH private key path for deploy target authentication."},{"name":"JARVIS_srv_PSWD","required":false,"secret":true,"description":"Optional SSH password used when sshpass authentication is preferred."}],"supports_registry":true,"services":%s,"capabilities":["git-sync","npm-install","build","deploy-web","deploy-scripts","mirror","webhook","docker-restart"],"tags":["jarvis","deploy","build","mcp","automation"]}}' \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "Synchronize source, build locally, deploy web code and scripts, mirror refs, redeploy the Portainer stack or trigger a webhook, and restart MCPO.")" \
    "$(metadata_services_json)")"
}

parse_cli_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --phase)
        shift
        [[ $# -gt 0 ]] || emit_mcp_error "Invalid argument" "--phase requires a value" "argument-parse"
        if [[ "$1" == "collect" || "$1" == "execute" ]]; then
          MCP_PHASE="$1"
        else
          PHASE="$1"
        fi
        ;;
      --confirmed)
        shift
        [[ $# -gt 0 ]] || emit_mcp_error "Invalid argument" "--confirmed requires true or false" "argument-parse"
        MCP_CONFIRMED="$1"
        ;;
      --param)
        shift
        [[ $# -gt 0 ]] || emit_mcp_error "Invalid argument" "--param requires key=value" "argument-parse"
        local kv="$1"
        local key="${kv%%=*}"
        local value="${kv#*=}"
        if [[ -z "$key" || "$key" == "$kv" ]]; then
          emit_mcp_error "Invalid parameter" "Expected --param key=value" "argument-parse"
        fi
        MCP_PARAMS["$key"]="$value"
        ;;
      --env)
        shift
        [[ $# -gt 0 ]] || emit_mcp_error "Invalid argument" "--env requires a file path" "argument-parse"
        ENV_FILE="$1"
        ENV_FILE_EXPLICIT=1
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      --json-stdout)
        JSON_STDOUT=1
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        emit_mcp_error "Invalid argument" "Unknown argument: $1" "argument-parse"
        ;;
    esac
    shift
  done
}

apply_mcp_adapter() {
  if [[ -z "$MCP_PHASE" ]]; then
    return
  fi

  JSON_STDOUT=1
  MCP_CONFIRMED="$(normalize_bool "$MCP_CONFIRMED")"
  MCP_MODE="${MCP_PARAMS[mode]:-}"
  [[ -n "$MCP_MODE" ]] || emit_mcp_error "Missing parameter" "Expected --param mode=..." "dispatch"

  case "$MCP_MODE" in
    self-doc|registry-doc|list-services|describe-service|validate-service-input)
      [[ "$MCP_PHASE" == "collect" ]] || emit_mcp_error "Invalid phase for mode" "Mode ${MCP_MODE} requires phase=collect" "$MCP_MODE"
      handle_metadata_mode "$MCP_MODE"
      exit 0
      ;;
    all|sync|install|build|deploy-web|deploy-scripts|mirror|webhook|restart)
      [[ "$MCP_PHASE" == "execute" ]] || emit_mcp_error "Invalid phase for mode" "Mode ${MCP_MODE} requires phase=execute" "$MCP_MODE"
      if [[ "$MCP_CONFIRMED" != "true" && "$(normalize_bool "${MCP_PARAMS[dry_run]:-${DRY_RUN}}")" != "true" ]]; then
        emit_mcp_error "Confirmation required" "Execution requires --confirmed true unless dry_run=true" "$MCP_MODE"
      fi
      PHASE="$MCP_MODE"
      DRY_RUN=$([[ "$(normalize_bool "${MCP_PARAMS[dry_run]:-${DRY_RUN}}")" == "true" ]] && printf '1' || printf '0')
      if [[ -n "${MCP_PARAMS[env_file]:-}" ]]; then
        ENV_FILE="${MCP_PARAMS[env_file]}"
        ENV_FILE_EXPLICIT=1
      fi
      ;;
    *)
      emit_mcp_error "Unsupported mode" "Unknown mode: ${MCP_MODE}" "$MCP_MODE"
      ;;
  esac
}

parse_cli_args "$@"
apply_mcp_adapter

########################################
# Logging / formatting
########################################

timestamp() {
  date +"%Y-%m-%d %H:%M:%S"
}

log() {
  echo
  echo "[$(timestamp)] ============================================================"
  echo "[$(timestamp)] [INFO] $*"
  echo "[$(timestamp)] ============================================================"
}

info() {
  echo "[$(timestamp)] [INFO] $*"
}

warn() {
  echo "[$(timestamp)] [WARN] $*" >&2
}

error() {
  echo "[$(timestamp)] [ERREUR] $*" >&2
}

die() {
  local msg="$1"
  local code="${2:-$EXIT_UNKNOWN}"
  error "$msg"
  finalize_summary "$code"
  emit_summary_stdout
  exit "$code"
}

emit_summary_stdout() {
  if [[ "$JSON_STDOUT" == "1" ]]; then
    if [[ -n "$LAST_SUMMARY_JSON" ]]; then
      printf '%s\n' "$LAST_SUMMARY_JSON" >&${ORIGINAL_STDOUT_FD}
    elif [[ -n "$SUMMARY_JSON" && -f "$SUMMARY_JSON" ]]; then
      cat "$SUMMARY_JSON" >&${ORIGINAL_STDOUT_FD}
    fi
  fi
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[$(timestamp)] [DRY-RUN] $*"
    return 0
  fi

  echo "[$(timestamp)] + $*"
  "$@"
}

run_shell() {
  local cmd="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[$(timestamp)] [DRY-RUN] $cmd"
    return 0
  fi

  echo "[$(timestamp)] + $cmd"
  bash -lc "$cmd"
}

run_sensitive() {
  local display="$1"
  shift

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[$(timestamp)] [DRY-RUN] $display"
    return 0
  fi

  echo "[$(timestamp)] + $display"
  "$@"
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "${1:-}" | sed "s/'/'\\\\''/g")"
}

normalize_base_url() {
  local value="${1:-}"
  value="${value%/}"
  case "$value" in
    http://*|https://*)
      printf '%s' "$value"
      ;;
    *)
      printf 'https://%s' "$value"
      ;;
  esac
}

has_portainer_redeploy_config() {
  [[ -n "${PORTAINER_URL:-}" && -n "${PORTAINER_USER:-}" && -n "${PORTAINER_PASSWORD:-}" && -n "${PORTAINER_ENDPOINT_ID:-}" && -n "${JARVIS_TOOLS_STACK_NAME:-}" ]]
}

docker_remote_base_cmd() {
  local quoted_password
  if [[ "$USE_SUDO" == "1" ]]; then
    if [[ "$SSH_AUTH_MODE" == "sshpass" && -n "${JARVIS_srv_PSWD:-}" ]]; then
      quoted_password="$(shell_quote "$JARVIS_srv_PSWD")"
      printf "printf '%%s\\n' %s | sudo -S -p '' docker" "$quoted_password"
      return 0
    fi

    printf 'sudo docker'
    return 0
  fi

  printf 'docker'
}

get_remote_container_started_at() {
  local container_name="$1"
  local docker_cmd quoted_container remote_cmd

  docker_cmd="$(docker_remote_base_cmd)"
  quoted_container="$(shell_quote "$container_name")"
  remote_cmd="$docker_cmd inspect --format '{{.State.StartedAt}}' $quoted_container 2>/dev/null || true"
  remote_exec_sensitive "docker inspect startedAt '$container_name'" "$remote_cmd"
}

wait_for_remote_container_redeploy() {
  local container_name="$1"
  local before_started_at="$2"
  local wait_seconds="$3"
  local after_started_at elapsed=0

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] verification du redeploy de $container_name"
    return 0
  fi

  info "Vérification redeploy conteneur = $container_name"
  info "StartedAt avant redeploy       = ${before_started_at:-<inconnu>}"

  while (( elapsed <= wait_seconds )); do
    after_started_at="$(get_remote_container_started_at "$container_name" | tr -d '\r' | tail -n 1)"
    if [[ -n "$after_started_at" ]]; then
      info "StartedAt courant             = $after_started_at"
      if [[ -z "$before_started_at" || "$after_started_at" != "$before_started_at" ]]; then
        info "Redeploy conteneur confirmé   = $container_name"
        return 0
      fi
    fi

    sleep 3
    elapsed=$((elapsed + 3))
  done

  die "Le conteneur $container_name n'a pas été redéployé après la phase webhook/redeploy" "$EXIT_WEBHOOK"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Commande absente: $1" "$EXIT_ENV"
}

mask_url() {
  sed -E 's#(https?://)[^/@]+@#\1***@#g'
}

json_escape() {
  printf '"%s"' "$(json_escape_shell "${1:-}")"
}

dir_is_writable() {
  local dir="$1"
  [[ -n "$dir" ]] || return 1
  mkdir -p "$dir" >/dev/null 2>&1 || return 1
  local probe_file="$dir/.jarvis_write_test_$$"
  if ! ( : > "$probe_file" ) >/dev/null 2>&1; then
    return 1
  fi
  rm -f "$probe_file" >/dev/null 2>&1 || true
  return 0
}

select_writable_dir() {
  local preferred="$1"
  local candidate=""

  if dir_is_writable "$preferred"; then
    printf '%s' "$preferred"
    return 0
  fi

  for candidate in "${TMPDIR:-}" /tmp /var/tmp "$PWD"; do
    [[ -n "$candidate" ]] || continue
    if dir_is_writable "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  return 1
}

configure_runtime_output_paths() {
  local writable_log_dir=""
  local writable_summary_dir=""

  if writable_log_dir="$(select_writable_dir "$LOG_DIR")"; then
    LOG_DIR="$writable_log_dir"
    LOG_FILE="${LOG_DIR}/jarvis_sync_${RUN_ID}.log"
  else
    LOG_TO_FILE=0
    LOG_FILE=""
  fi

  if writable_summary_dir="$(select_writable_dir "$SUMMARY_DIR")"; then
    SUMMARY_DIR="$writable_summary_dir"
    SUMMARY_JSON="${SUMMARY_DIR}/jarvis_sync_${RUN_ID}.json"
  else
    SUMMARY_JSON=""
  fi
}

run_internal_git_mirror() {
  local mirror_dir
  mirror_dir="$(mktemp -d)"

  cleanup_internal_git_mirror() {
    rm -rf "$mirror_dir" >/dev/null 2>&1 || true
  }

  trap cleanup_internal_git_mirror RETURN

  substep_next "clone miroir github"
  run_sensitive \
    "git clone --mirror $(printf '%s\n' "$GITHUB_REPO_URL" | mask_url) ${mirror_dir}/repo.git" \
    git clone --mirror "$GITHUB_REPO_URL" "${mirror_dir}/repo.git"

  substep_next "synchronisation origin"
  run git -C "${mirror_dir}/repo.git" fetch --prune origin

  substep_next "push branches et tags"
  run_sensitive \
    "git -C ${mirror_dir}/repo.git push --prune $(printf '%s\n' "$GITEA_REPO_URL" | mask_url) +refs/heads/*:refs/heads/*" \
    git -C "${mirror_dir}/repo.git" push --prune "$GITEA_REPO_URL" +refs/heads/*:refs/heads/*

  run_sensitive \
    "git -C ${mirror_dir}/repo.git push --prune $(printf '%s\n' "$GITEA_REPO_URL" | mask_url) +refs/tags/*:refs/tags/*" \
    git -C "${mirror_dir}/repo.git" push --prune "$GITEA_REPO_URL" +refs/tags/*:refs/tags/*
}

########################################
# Summary / step tracking
########################################

STEP_RESULTS=()

init_step_sequence() {
  STEP_SEQUENCE=("prechecks")
  local candidate
  for candidate in sync install build deploy-web deploy-scripts mirror webhook restart; do
    if phase_enabled "$candidate"; then
      STEP_SEQUENCE+=("$candidate")
    fi
  done
  TOTAL_STEPS=${#STEP_SEQUENCE[@]}
}

resolve_step_index() {
  local target="$1"
  local idx=1
  local item

  for item in "${STEP_SEQUENCE[@]}"; do
    if [[ "$item" == "$target" ]]; then
      printf '%s' "$idx"
      return 0
    fi
    idx=$((idx + 1))
  done

  printf '0'
}

step_label() {
  local index="$1"
  if [[ "$index" -gt 0 && "$TOTAL_STEPS" -gt 0 ]]; then
    printf 'STEP %s/%s' "$index" "$TOTAL_STEPS"
  else
    printf 'STEP'
  fi
}

substep_total_for() {
  case "$1" in
    prechecks) printf '4' ;;
    sync) printf '6' ;;
    install) printf '2' ;;
    build) printf '1' ;;
    deploy-web) printf '2' ;;
    deploy-scripts) printf '3' ;;
    mirror) printf '5' ;;
    webhook) printf '4' ;;
    restart) printf '1' ;;
    *) printf '0' ;;
  esac
}

substep_label() {
  if [[ "$CURRENT_SUBSTEP_TOTAL" -gt 0 ]]; then
    printf '%s/%s' "$CURRENT_SUBSTEP_INDEX" "$CURRENT_SUBSTEP_TOTAL"
  else
    printf '-/-'
  fi
}

announce_step_sequence() {
  local idx=1
  local items=()
  local item
  for item in "${STEP_SEQUENCE[@]}"; do
    items+=("${idx}/${TOTAL_STEPS} ${item}")
    idx=$((idx + 1))
  done
  info "SEQUENCE = ${items[*]}"
}

substep_next() {
  local label="$1"
  if [[ "$CURRENT_SUBSTEP_TOTAL" -le 0 ]]; then
    info "$(step_label "$CURRENT_STEP_INDEX") | -/- | $label"
    return 0
  fi

  if [[ "$CURRENT_SUBSTEP_INDEX" -lt "$CURRENT_SUBSTEP_TOTAL" ]]; then
    CURRENT_SUBSTEP_INDEX=$((CURRENT_SUBSTEP_INDEX + 1))
  fi

  info "$(step_label "$CURRENT_STEP_INDEX") | $(substep_label) | $label"
}

step_start() {
  CURRENT_STEP="$1"
  CURRENT_STEP_STATUS="running"
  CURRENT_STEP_INDEX="$(resolve_step_index "$CURRENT_STEP")"
  CURRENT_SUBSTEP_INDEX=0
  CURRENT_SUBSTEP_TOTAL="$(substep_total_for "$CURRENT_STEP")"
  log "$(step_label "$CURRENT_STEP_INDEX") START: $CURRENT_STEP"
}

step_ok() {
  local msg="${1:-OK}"
  CURRENT_STEP_STATUS="ok"
  STEP_RESULTS+=("{\"step\":\"$CURRENT_STEP\",\"status\":\"ok\",\"message\":$(json_escape "$msg")}")
  info "$(step_label "$CURRENT_STEP_INDEX") OK: $CURRENT_STEP - $msg"
}

step_fail() {
  local msg="${1:-FAILED}"
  CURRENT_STEP_STATUS="failed"
  STEP_RESULTS+=("{\"step\":\"$CURRENT_STEP\",\"status\":\"failed\",\"message\":$(json_escape "$msg")}")
  error "$(step_label "$CURRENT_STEP_INDEX") FAIL: $CURRENT_STEP - $msg"
}

finalize_summary() {
  local exit_code="${1:-0}"
  local steps_json
  local summary_payload
  if [[ ${#STEP_RESULTS[@]} -eq 0 ]]; then
    steps_json="[]"
  else
    local joined
    joined="$(IFS=,; echo "${STEP_RESULTS[*]}")"
    steps_json="[$joined]"
  fi

  summary_payload="$(cat <<EOF
{
  "run_id": "$(printf '%s' "$RUN_ID")",
  "timestamp": "$(timestamp)",
  "phase": "$(printf '%s' "$PHASE")",
  "dry_run": $DRY_RUN,
  "exit_code": $exit_code,
  "ssh_auth_mode": $(json_escape "$SSH_AUTH_MODE"),
  "log_file": $(json_escape "$LOG_FILE"),
  "summary_file": $(json_escape "$SUMMARY_JSON"),
  "steps": $steps_json
}
EOF
)"

  LAST_SUMMARY_JSON="$summary_payload"

  if [[ -n "$SUMMARY_JSON" ]]; then
    printf '%s\n' "$summary_payload" > "$SUMMARY_JSON" 2>/dev/null || true
  fi
}

on_error() {
  local exit_code=$?
  local line_no="${1:-unknown}"
  step_fail "Erreur bash à la ligne $line_no (code=$exit_code)"
  finalize_summary "$exit_code"
  echo
  echo "[$(timestamp)] ############################################################"
  echo "[$(timestamp)] [ERREUR] Échec à la ligne ${line_no} (code=${exit_code})"
  echo "[$(timestamp)] [ERREUR] Voir le log     : $LOG_FILE"
  echo "[$(timestamp)] [ERREUR] Voir le résumé  : $SUMMARY_JSON"
  echo "[$(timestamp)] ############################################################"
  emit_summary_stdout
  exit "$exit_code"
}

trap 'on_error $LINENO' ERR

configure_runtime_output_paths

if [[ "$LOG_TO_FILE" == "1" && -n "$LOG_FILE" ]]; then
  if [[ "$JSON_STDOUT" == "1" ]]; then
    exec > >(tee -a "$LOG_FILE" >&2) 2>&1
  else
    exec > >(tee -a "$LOG_FILE") 2>&1
  fi
elif [[ "$JSON_STDOUT" == "1" ]]; then
  exec > >(cat >&2) 2>&1
fi

########################################
# Load env
########################################

ENV_SOURCE="process-env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  ENV_SOURCE="$ENV_FILE"
elif [[ "$ENV_FILE_EXPLICIT" == "1" ]]; then
  die "Fichier .env introuvable : $ENV_FILE" "$EXIT_ENV"
fi

########################################
# Required env vars
########################################

JARVIS_BRANCH="${JARVIS_BRANCH:-main}"

NPM_INSTALL_CMD="${NPM_INSTALL_CMD:-npm ci}"
NPM_BUILD_CMD="${NPM_BUILD_CMD:-npm run build}"
NPM_FALLBACK_INSTALL_CMD="${NPM_FALLBACK_INSTALL_CMD:-npm install}"
NPM_ALLOW_FALLBACK_INSTALL="${NPM_ALLOW_FALLBACK_INSTALL:-0}"
STOP_ON_LOCK_MISMATCH="${STOP_ON_LOCK_MISMATCH:-1}"

GITHUB_REPO_URL="${GITHUB_REPO_URL:-https://${jarvis_tools_GITHUB_TOKEN:-}@github.com/papapingouin-be/jarvis-mcp.git}"
GITEA_REPO_URL="${GITEA_REPO_URL:-https://${jarvis_tools_GITEA_TOKEN:-}@webgit.jarvis.papapingouinbe.duckdns.org/jarvisadmin/jarvis-mcp-tools.git}"
GITHUB_REMOTE_NAME="${GITHUB_REMOTE_NAME:-github-src}"

WEB_CODE_LOCAL_SUBDIR="${WEB_CODE_LOCAL_SUBDIR:-apps/config-web}"
WEB_REMOTE_PATH="${WEB_REMOTE_PATH:-/opt/jarvis/config-web}"
WEB_REMOTE_DELETE="${WEB_REMOTE_DELETE:-1}"
WEB_RSYNC_EXCLUDES="${WEB_RSYNC_EXCLUDES:-data/scripts/}"

SCRIPT_SOURCE_LOCAL_SUBDIR="${SCRIPT_SOURCE_LOCAL_SUBDIR:-tools/scripts}"
SCRIPT_REMOTE_PATH="${SCRIPT_REMOTE_PATH:-/opt/jarvis/shared/scripts}"
SCRIPT_REMOTE_DELETE="${SCRIPT_REMOTE_DELETE:-1}"
SCRIPT_DIR_MODE="${SCRIPT_DIR_MODE:-755}"
SCRIPT_FILE_MODE="${SCRIPT_FILE_MODE:-644}"

PORTAINER_USE_STACK_WEBHOOK="${PORTAINER_USE_STACK_WEBHOOK:-1}"
PORTAINER_URL="${PORTAINER_URL:-${jarvis_tools_PORTAINER_URL:-}}"
PORTAINER_USER="${PORTAINER_USER:-${jarvis_tools_PORTAINER_USER:-}}"
PORTAINER_PASSWORD="${PORTAINER_PASSWORD:-${jarvis_tools_PORTAINER_PASSWORD:-}}"
PORTAINER_ENDPOINT_ID="${PORTAINER_ENDPOINT_ID:-3}"
JARVIS_TOOLS_STACK_NAME="${JARVIS_TOOLS_STACK_NAME:-jarvis-tools}"
JARVIS_TOOLS_CONTAINER_NAME="${JARVIS_TOOLS_CONTAINER_NAME:-jarvis-mcp-tools}"
PORTAINER_REDEPLOY_WAIT_SECONDS="${PORTAINER_REDEPLOY_WAIT_SECONDS:-90}"
PORTAINER_API_FALLBACK_TO_REMOTE_COMPOSE="${PORTAINER_API_FALLBACK_TO_REMOTE_COMPOSE:-1}"
JARVIS_TOOLS_REMOTE_COMPOSE_FILE="${JARVIS_TOOLS_REMOTE_COMPOSE_FILE:-/opt/jarvis/repos/jarvis-mcp-tools/deploy/compose.yml}"
JARVIS_TOOLS_REMOTE_ENV_FILE="${JARVIS_TOOLS_REMOTE_ENV_FILE:-/opt/jarvis/mcp/jarvis_sync_build_redeploy.env}"
JARVIS_TOOLS_REMOTE_PROJECT_NAME="${JARVIS_TOOLS_REMOTE_PROJECT_NAME:-jarvis-tools}"
RESTART_STRATEGY="${RESTART_STRATEGY:-docker}"
JARVIS_MCPO_CONTAINER_NAME="${JARVIS_MCPO_CONTAINER_NAME:-jarvis_mcpo}"

USE_SUDO="${USE_SUDO:-1}"

########################################
# Helpers
########################################

phase_enabled() {
  local wanted="$1"
  [[ "$PHASE" == "all" || "$PHASE" == "$wanted" ]]
}

init_step_sequence
announce_step_sequence

require_env_for_selected_phases() {
  local env_name="$1"
  local value="$2"
  shift 2
  local candidate_phase

  for candidate_phase in "$@"; do
    if phase_enabled "$candidate_phase"; then
      [[ -n "$value" ]] || die "Variable manquante: $env_name" "$EXIT_ENV"
      return 0
    fi
  done
}

command_required_for_selected_phases() {
  local command_name="$1"
  shift
  local candidate_phase

  for candidate_phase in "$@"; do
    if phase_enabled "$candidate_phase"; then
      need_cmd "$command_name"
      return 0
    fi
  done
}

docker_cmd() {
  if [[ "$USE_SUDO" == "1" ]]; then
    sudo docker "$@"
  else
    docker "$@"
  fi
}

ssh_host() {
  printf '%s' "${JARVIS_srv_SSH%%:*}"
}

ssh_port() {
  printf '%s' "${JARVIS_srv_SSH##*:}"
}

mask_host() {
  printf '%s\n' "$1" | sed -E 's#^([^:]+):([0-9]+)$#\1:\2#'
}

print_git_remotes_masked() {
  info "Remotes Git configurés :"
  while IFS= read -r remote_name; do
    [[ -n "$remote_name" ]] || continue
    local remote_url
    remote_url="$(git -c safe.directory="${JARVIS_LOCAL_REPO:-$PWD}" remote get-url "$remote_name" 2>/dev/null | mask_url || true)"
    [[ -n "$remote_url" ]] || remote_url="<url indisponible>"
    info "  - $remote_name => $remote_url"
  done < <(git -c safe.directory="${JARVIS_LOCAL_REPO:-$PWD}" remote 2>/dev/null || true)
}

detect_ssh_auth_mode() {
  local home_dir="${HOME:-}"

  if command -v sshpass >/dev/null 2>&1 && [[ -n "${JARVIS_srv_PSWD:-}" ]]; then
    SSH_AUTH_MODE="sshpass"
    return 0
  fi

  if [[ -n "${JARVIS_SSH_KEY_PATH:-}" ]]; then
    [[ -f "$JARVIS_SSH_KEY_PATH" ]] || die "Clé SSH introuvable: $JARVIS_SSH_KEY_PATH" "$EXIT_DEPLOY_WEB"
    SSH_AUTH_MODE="keyfile"
    return 0
  fi

  if [[ -z "$home_dir" ]] && command -v getent >/dev/null 2>&1; then
    home_dir="$(getent passwd "$(id -u)" | cut -d: -f6 2>/dev/null || true)"
  fi

  if [[ -n "$home_dir" && ( -f "$home_dir/.ssh/id_rsa" || -f "$home_dir/.ssh/id_ed25519" ) ]]; then
    SSH_AUTH_MODE="agent_or_default_key"
    return 0
  fi

  die "Impossible de déployer en SSH: ni sshpass+mot de passe, ni clé SSH disponible" "$EXIT_DEPLOY_WEB"
}

remote_exec() {
  local remote_cmd="$1"
  local host port
  host="$(ssh_host)"
  port="$(ssh_port)"

  case "$SSH_AUTH_MODE" in
    sshpass)
      run_sensitive \
        "sshpass ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $port ${JARVIS_srv_USER}@${host} $remote_cmd" \
        env SSHPASS="$JARVIS_srv_PSWD" sshpass -e ssh \
          -o StrictHostKeyChecking=no \
          -o UserKnownHostsFile=/dev/null \
          -p "$port" \
          "${JARVIS_srv_USER}@${host}" \
          "$remote_cmd"
      ;;
    keyfile)
      run ssh \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -i "$JARVIS_SSH_KEY_PATH" \
        -p "$port" \
        "${JARVIS_srv_USER}@${host}" \
        "$remote_cmd"
      ;;
    agent_or_default_key)
      run ssh \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -p "$port" \
        "${JARVIS_srv_USER}@${host}" \
        "$remote_cmd"
      ;;
    *)
      die "Mode SSH inconnu: $SSH_AUTH_MODE" "$EXIT_DEPLOY_WEB"
      ;;
  esac
}

remote_exec_sensitive() {
  local display_cmd="$1"
  local remote_cmd="$2"
  local host port
  host="$(ssh_host)"
  port="$(ssh_port)"

  case "$SSH_AUTH_MODE" in
    sshpass)
      run_sensitive \
        "sshpass ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $port ${JARVIS_srv_USER}@${host} $display_cmd" \
        env SSHPASS="$JARVIS_srv_PSWD" sshpass -e ssh \
          -o StrictHostKeyChecking=no \
          -o UserKnownHostsFile=/dev/null \
          -p "$port" \
          "${JARVIS_srv_USER}@${host}" \
          "$remote_cmd"
      ;;
    keyfile)
      run ssh \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -i "$JARVIS_SSH_KEY_PATH" \
        -p "$port" \
        "${JARVIS_srv_USER}@${host}" \
        "$remote_cmd"
      ;;
    agent_or_default_key)
      run ssh \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -p "$port" \
        "${JARVIS_srv_USER}@${host}" \
        "$remote_cmd"
      ;;
    *)
      die "Mode SSH inconnu: $SSH_AUTH_MODE" "$EXIT_DEPLOY_WEB"
      ;;
  esac
}

rsync_copy_dir() {
  local source_path="$1"
  local remote_path="$2"
  local delete_mode="$3"
  local exit_code="$4"
  local excludes_raw="${5:-}"

  local host port
  host="$(ssh_host)"
  port="$(ssh_port)"

  [[ -d "$source_path" ]] || die "Source introuvable: $source_path" "$exit_code"

  local rsync_delete_arg=()
  if [[ "$delete_mode" == "1" ]]; then
    rsync_delete_arg+=(--delete)
  fi

  local rsync_exclude_args=()
  if [[ -n "$excludes_raw" ]]; then
    local exclude_entry
    OLD_IFS="$IFS"
    IFS=';'
    for exclude_entry in $excludes_raw; do
      [[ -n "$exclude_entry" ]] || continue
      rsync_exclude_args+=(--exclude "$exclude_entry")
    done
    IFS="$OLD_IFS"
  fi

  remote_exec "mkdir -p '$remote_path'"

  case "$SSH_AUTH_MODE" in
    sshpass)
      run_sensitive \
        "sshpass rsync -avz ${rsync_delete_arg[*]:-} -e 'ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null' ${source_path}/ ${JARVIS_srv_USER}@${host}:${remote_path}/" \
        env SSHPASS="$JARVIS_srv_PSWD" sshpass -e rsync -avz \
          "${rsync_delete_arg[@]}" \
          "${rsync_exclude_args[@]}" \
          -e "ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
          "${source_path}/" \
          "${JARVIS_srv_USER}@${host}:${remote_path}/"
      ;;
    keyfile)
      run rsync -avz \
        "${rsync_delete_arg[@]}" \
        "${rsync_exclude_args[@]}" \
        -e "ssh -i $JARVIS_SSH_KEY_PATH -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
        "${source_path}/" \
        "${JARVIS_srv_USER}@${host}:${remote_path}/"
      ;;
    agent_or_default_key)
      run rsync -avz \
        "${rsync_delete_arg[@]}" \
        "${rsync_exclude_args[@]}" \
        -e "ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
        "${source_path}/" \
        "${JARVIS_srv_USER}@${host}:${remote_path}/"
      ;;
    *)
      die "Mode SSH inconnu: $SSH_AUTH_MODE" "$exit_code"
      ;;
  esac
}

verify_remote_permissions() {
  local remote_path="$1"
  local dir_mode="$2"
  local file_mode="$3"

  info "Vérification des permissions distantes sur $remote_path"
  remote_exec "find '$remote_path' -type d -exec chmod $dir_mode {} +"
  remote_exec "find '$remote_path' -type f -exec chmod $file_mode {} +"
  remote_exec "echo '[REMOTE] Aperçu permissions:' && ls -la '$remote_path' | sed -n '1,20p'"
}

deploy_web_code() {
  local source_path
  source_path="${JARVIS_LOCAL_REPO%/}/${WEB_CODE_LOCAL_SUBDIR}"

  substep_next "preparation du paquet web"
  info "Source locale web      = $source_path"
  info "Serveur distant        = ${JARVIS_srv_USER}@$(mask_host "$JARVIS_srv_SSH")"
  info "Destination web        = $WEB_REMOTE_PATH"
  info "Mode auth SSH          = $SSH_AUTH_MODE"
  info "Exclusions rsync web   = $WEB_RSYNC_EXCLUDES"

  substep_next "copie rsync web"
  rsync_copy_dir "$source_path" "$WEB_REMOTE_PATH" "$WEB_REMOTE_DELETE" "$EXIT_DEPLOY_WEB" "$WEB_RSYNC_EXCLUDES"
}

deploy_scripts_data() {
  local source_path
  source_path="${JARVIS_LOCAL_REPO%/}/${SCRIPT_SOURCE_LOCAL_SUBDIR}"

  substep_next "preparation des scripts"
  info "Source locale scripts  = $source_path"
  info "Serveur distant        = ${JARVIS_srv_USER}@$(mask_host "$JARVIS_srv_SSH")"
  info "Destination scripts    = $SCRIPT_REMOTE_PATH"
  info "Mode auth SSH          = $SSH_AUTH_MODE"

  substep_next "copie rsync scripts"
  rsync_copy_dir "$source_path" "$SCRIPT_REMOTE_PATH" "$SCRIPT_REMOTE_DELETE" "$EXIT_DEPLOY_SCRIPTS"
  substep_next "verification des permissions"
  verify_remote_permissions "$SCRIPT_REMOTE_PATH" "$SCRIPT_DIR_MODE" "$SCRIPT_FILE_MODE"
}

trigger_webhook() {
  local url="$1"
  local response http_code

  response="$(mktemp)"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] POST $url"
    rm -f "$response"
    return 0
  fi

  http_code="$(curl -ksS -o "$response" -w "%{http_code}" -X POST "$url")"

  if [[ "$http_code" != "200" && "$http_code" != "204" ]]; then
    echo "[ERREUR] Webhook Portainer en échec (HTTP $http_code)" >&2
    cat "$response" >&2 || true
    rm -f "$response"
    die "Échec webhook Portainer" "$EXIT_WEBHOOK"
  fi

  rm -f "$response"
  info "Webhook Portainer déclenché"
}

redeploy_portainer_stack() {
  local base_url auth_payload auth_response http_code token resolved_stack_id
  local auth_file redeploy_file

  base_url="$(normalize_base_url "$PORTAINER_URL")"
  auth_file="$(mktemp)"
  redeploy_file="$(mktemp)"

  auth_payload="$(jq -cn --arg username "$PORTAINER_USER" --arg password "$PORTAINER_PASSWORD" '{Username:$username,Password:$password}')"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] POST $base_url/api/auth"
    info "[DRY-RUN] GET $base_url/api/stacks?endpointId=$PORTAINER_ENDPOINT_ID"
    info "[DRY-RUN] Resolve stack name '$JARVIS_TOOLS_STACK_NAME'"
    info "[DRY-RUN] PUT $base_url/api/stacks/<resolved-id>/git/redeploy?endpointId=$PORTAINER_ENDPOINT_ID"
    rm -f "$auth_file" "$redeploy_file"
    return 0
  fi

  auth_response="$(curl -ksS -o "$auth_file" -w "%{http_code}" \
    -H 'Content-Type: application/json' \
    -X POST \
    -d "$auth_payload" \
    "$base_url/api/auth")"

  if [[ "$auth_response" != "200" && "$auth_response" != "204" ]]; then
    echo "[ERREUR] Auth Portainer en échec (HTTP $auth_response)" >&2
    cat "$auth_file" >&2 || true
    rm -f "$auth_file" "$redeploy_file"
    die "Échec authentification Portainer" "$EXIT_WEBHOOK"
  fi

  token="$(jq -r '.jwt // empty' "$auth_file")"
  if [[ -z "$token" ]]; then
    rm -f "$auth_file" "$redeploy_file"
    die "Réponse Portainer invalide: JWT manquant" "$EXIT_WEBHOOK"
  fi

  http_code="$(curl -ksS -o "$redeploy_file" -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    "$base_url/api/stacks?endpointId=$PORTAINER_ENDPOINT_ID")"

  if [[ "$http_code" != "200" && "$http_code" != "204" ]]; then
    echo "[ERREUR] Redeploy stack Portainer en échec (HTTP $http_code)" >&2
    cat "$redeploy_file" >&2 || true
    rm -f "$auth_file" "$redeploy_file"
    die "Échec redeploy stack Portainer" "$EXIT_WEBHOOK"
  fi

  rm -f "$auth_file" "$redeploy_file"
  info "Stack Portainer redéployée"
}

docker_restart_container() {
  local container_name="$1"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] docker restart $container_name"
    return 0
  fi

  if ! docker_cmd ps -a --format '{{.Names}}' | grep -Fxq "$container_name"; then
    die "Conteneur Docker introuvable ou accès refusé: $container_name" "$EXIT_DOCKER"
  fi

  run docker_cmd restart "$container_name"
}

redeploy_portainer_stack_by_name() {
  local base_url auth_payload auth_response http_code token resolved_stack_id
  local auth_file redeploy_file

  base_url="$(normalize_base_url "$PORTAINER_URL")"
  auth_file="$(mktemp)"
  redeploy_file="$(mktemp)"

  auth_payload="$(jq -cn --arg username "$PORTAINER_USER" --arg password "$PORTAINER_PASSWORD" '{Username:$username,Password:$password}')"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] POST $base_url/api/auth"
    info "[DRY-RUN] GET $base_url/api/stacks?endpointId=$PORTAINER_ENDPOINT_ID"
    info "[DRY-RUN] Resolve stack name '$JARVIS_TOOLS_STACK_NAME'"
    info "[DRY-RUN] PUT $base_url/api/stacks/<resolved-id>/git/redeploy?endpointId=$PORTAINER_ENDPOINT_ID"
    return 0
  fi

  auth_response="$(curl -ksS -o "$auth_file" -w "%{http_code}" \
    -H 'Content-Type: application/json' \
    -X POST \
    -d "$auth_payload" \
    "$base_url/api/auth")"

  if [[ "$auth_response" != "200" && "$auth_response" != "204" ]]; then
    echo "[ERREUR] Auth Portainer en echec (HTTP $auth_response)" >&2
    cat "$auth_file" >&2 || true
    rm -f "$auth_file" "$redeploy_file"
    die "Echec authentification Portainer" "$EXIT_WEBHOOK"
  fi

  token="$(jq -r '.jwt // empty' "$auth_file")"
  if [[ -z "$token" ]]; then
    rm -f "$auth_file" "$redeploy_file"
    die "Reponse Portainer invalide: JWT manquant" "$EXIT_WEBHOOK"
  fi

  http_code="$(curl -ksS -o "$redeploy_file" -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    "$base_url/api/stacks?endpointId=$PORTAINER_ENDPOINT_ID")"

  if [[ "$http_code" != "200" && "$http_code" != "204" ]]; then
    echo "[ERREUR] Lecture stacks Portainer en echec (HTTP $http_code)" >&2
    cat "$redeploy_file" >&2 || true
    rm -f "$auth_file" "$redeploy_file"
    die "Echec lecture stacks Portainer" "$EXIT_WEBHOOK"
  fi

  resolved_stack_id="$(jq -r --arg stack_name "$JARVIS_TOOLS_STACK_NAME" 'map(select(.Name == $stack_name)) | .[0].Id // empty' "$redeploy_file")"
  if [[ -z "$resolved_stack_id" ]]; then
    rm -f "$auth_file" "$redeploy_file"
    die "Stack Portainer introuvable: $JARVIS_TOOLS_STACK_NAME" "$EXIT_WEBHOOK"
  fi

  http_code="$(curl -ksS -o "$redeploy_file" -w "%{http_code}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $token" \
    -X PUT \
    -d '{}' \
    "$base_url/api/stacks/$resolved_stack_id/git/redeploy?endpointId=$PORTAINER_ENDPOINT_ID")"

  if [[ "$http_code" != "200" && "$http_code" != "204" ]]; then
    if portainer_redeploy_should_fallback "$http_code" "$redeploy_file"; then
      warn "Portainer API redeploy failed on private Git stack (HTTP $http_code)"
      warn "Portainer returned: $(tr '\n' ' ' < "$redeploy_file" | sed 's/[[:space:]]\+/ /g')"
      info "Fallback active: redeploy docker compose distant suite a l'erreur Portainer Git prive"
      rm -f "$auth_file" "$redeploy_file"
      redeploy_jarvis_tools_remote_compose
      info "Fallback succeeded: remote docker compose redeploy termine"
      return 0
    fi
    echo "[ERREUR] Redeploy stack Portainer en echec (HTTP $http_code)" >&2
    cat "$redeploy_file" >&2 || true
    rm -f "$auth_file" "$redeploy_file"
    die "Echec redeploy stack Portainer" "$EXIT_WEBHOOK"
  fi

  rm -f "$auth_file" "$redeploy_file"
  info "Stack Portainer redeployee"
}

portainer_redeploy_should_fallback() {
  local http_code="$1"
  local response_file="$2"
  [[ "${PORTAINER_API_FALLBACK_TO_REMOTE_COMPOSE:-0}" == "1" ]] || return 1
  [[ "$http_code" == "500" ]] || return 1
  [[ -f "$response_file" ]] || return 1
  grep -Eiq 'Unable to clone git repository|authentication required|Unauthorized' "$response_file"
}

redeploy_jarvis_tools_remote_compose() {
  local docker_cmd compose_file env_file project_name remote_cmd

  compose_file="$(shell_quote "$JARVIS_TOOLS_REMOTE_COMPOSE_FILE")"
  env_file="$(shell_quote "$JARVIS_TOOLS_REMOTE_ENV_FILE")"
  project_name="$(shell_quote "$JARVIS_TOOLS_REMOTE_PROJECT_NAME")"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] fallback remote docker compose redeploy"
    info "[DRY-RUN] compose file = $JARVIS_TOOLS_REMOTE_COMPOSE_FILE"
    info "[DRY-RUN] env file     = $JARVIS_TOOLS_REMOTE_ENV_FILE"
    info "[DRY-RUN] project      = $JARVIS_TOOLS_REMOTE_PROJECT_NAME"
    return 0
  fi

  docker_cmd="$(docker_remote_base_cmd)"
  remote_cmd="set -e; $docker_cmd compose --env-file $env_file -f $compose_file -p $project_name up -d --build --force-recreate $JARVIS_TOOLS_CONTAINER_NAME"
  info "Fallback remote compose start"
  remote_exec_sensitive "fallback docker compose redeploy '$JARVIS_TOOLS_REMOTE_PROJECT_NAME'" "$remote_cmd"
  info "Fallback remote compose done"
}

docker_restart_container_remote() {
  local container_name="$1"
  local remote_docker_cmd
  local remote_ps_cmd
  local remote_restart_cmd
  local quoted_container

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] remote docker restart $container_name"
    return 0
  fi

  remote_docker_cmd="$(docker_remote_base_cmd)"

  quoted_container="$(shell_quote "$container_name")"
  remote_ps_cmd="$remote_docker_cmd ps -a --format '{{.Names}}' | grep -Fxq $quoted_container"
  remote_restart_cmd="$remote_docker_cmd restart $quoted_container"

  remote_exec_sensitive "sudo docker ps -a --format '{{.Names}}' | grep -Fxq '$container_name'" "$remote_ps_cmd"
  remote_exec_sensitive "sudo docker restart '$container_name'" "$remote_restart_cmd"
}

restart_runtime() {
  case "$RESTART_STRATEGY" in
    webhook|portainer-webhook)
      trigger_webhook "$JARVIS_TOOLS_WEBHOOK_URL"
      ;;
    docker)
      docker_restart_container_remote "$JARVIS_MCPO_CONTAINER_NAME"
      ;;
    *)
      die "Strategie de restart inconnue: $RESTART_STRATEGY" "$EXIT_DOCKER"
      ;;
  esac
}

run_npm_install_phase() {
  local err_file ci_rc=0

  err_file="$(mktemp)"

  set +e
  bash -lc "$NPM_INSTALL_CMD" 2> >(tee "$err_file" >&2)
  ci_rc=$?
  set -e

  if [[ $ci_rc -eq 0 ]]; then
    info "Installation npm OK via: $NPM_INSTALL_CMD"
    rm -f "$err_file"
    return 0
  fi

  warn "Échec de la commande npm: $NPM_INSTALL_CMD"

  if grep -q "package.json and package-lock.json.*are in sync" "$err_file"; then
    warn "package.json et package-lock.json ne sont pas synchronisés"

    if [[ "$STOP_ON_LOCK_MISMATCH" == "1" && "$NPM_ALLOW_FALLBACK_INSTALL" != "1" ]]; then
      rm -f "$err_file"
      die "Le dépôt source est incohérent: package-lock.json non synchronisé avec package.json" "$EXIT_NPM_INSTALL"
    fi

    if [[ "$NPM_ALLOW_FALLBACK_INSTALL" == "1" ]]; then
      warn "Fallback activé: tentative avec '$NPM_FALLBACK_INSTALL_CMD'"
      run_shell "$NPM_FALLBACK_INSTALL_CMD"
      warn "Le build local continue, mais le repo source doit être corrigé côté GitHub."
      rm -f "$err_file"
      return 0
    fi
  fi

  rm -f "$err_file"
  die "Échec installation npm" "$EXIT_NPM_INSTALL"
}

########################################
# Pre-checks
########################################

step_start "prechecks"
substep_next "validation de l'environnement"

require_env_for_selected_phases JARVIS_LOCAL_REPO "${JARVIS_LOCAL_REPO:-}" all sync install build deploy-web deploy-scripts
require_env_for_selected_phases jarvis_tools_GITHUB_TOKEN "${jarvis_tools_GITHUB_TOKEN:-}" all sync mirror
require_env_for_selected_phases jarvis_tools_GITEA_TOKEN "${jarvis_tools_GITEA_TOKEN:-}" all mirror
require_env_for_selected_phases JARVIS_srv_SSH "${JARVIS_srv_SSH:-}" all deploy-web deploy-scripts restart
require_env_for_selected_phases JARVIS_srv_USER "${JARVIS_srv_USER:-}" all deploy-web deploy-scripts restart
if [[ "$RESTART_STRATEGY" == "webhook" || "$RESTART_STRATEGY" == "portainer-webhook" ]]; then
  require_env_for_selected_phases JARVIS_TOOLS_WEBHOOK_URL "${JARVIS_TOOLS_WEBHOOK_URL:-}" all restart
fi
if ( phase_enabled "all" || phase_enabled "webhook" ) && ! has_portainer_redeploy_config; then
  require_env_for_selected_phases JARVIS_TOOLS_WEBHOOK_URL "${JARVIS_TOOLS_WEBHOOK_URL:-}" all webhook
fi

need_cmd git
need_cmd npm
need_cmd curl
need_cmd bash
need_cmd python3
need_cmd jq
substep_next "validation des commandes"
command_required_for_selected_phases ssh all deploy-web deploy-scripts restart
command_required_for_selected_phases rsync all deploy-web deploy-scripts
if [[ "$RESTART_STRATEGY" == "docker" ]]; then
  : "${JARVIS_MCPO_CONTAINER_NAME:?Variable manquante: JARVIS_MCPO_CONTAINER_NAME}"
fi
if phase_enabled "all" || phase_enabled "webhook"; then
  : "${JARVIS_TOOLS_CONTAINER_NAME:?Variable manquante: JARVIS_TOOLS_CONTAINER_NAME}"
fi

if phase_enabled "all" || phase_enabled "sync" || phase_enabled "install" || phase_enabled "build" || phase_enabled "deploy-web" || phase_enabled "deploy-scripts"; then
  [[ -d "${JARVIS_LOCAL_REPO}/.git" ]] || die "Repo local introuvable: ${JARVIS_LOCAL_REPO}/.git" "$EXIT_ENV"
fi

if false; then
  :
fi

if phase_enabled "all" || phase_enabled "deploy-web" || phase_enabled "deploy-scripts" || phase_enabled "restart" || phase_enabled "webhook"; then
  detect_ssh_auth_mode
fi
substep_next "detection du mode ssh"

info "ENV_FILE                    = $ENV_FILE"
info "ENV_SOURCE                  = $ENV_SOURCE"
info "LOG_FILE                    = $LOG_FILE"
info "SUMMARY_JSON                = $SUMMARY_JSON"
info "PHASE                       = $PHASE"
info "DRY_RUN                     = $DRY_RUN"
info "JSON_STDOUT                 = $JSON_STDOUT"
info "USE_SUDO                    = $USE_SUDO"
info "JARVIS_LOCAL_REPO           = ${JARVIS_LOCAL_REPO:-}"
info "JARVIS_BRANCH               = $JARVIS_BRANCH"
info "GITHUB_REMOTE_NAME          = $GITHUB_REMOTE_NAME"
info "GITHUB_REPO_URL             = $(printf '%s\n' "$GITHUB_REPO_URL" | mask_url)"
info "GITEA_REPO_URL              = $(printf '%s\n' "$GITEA_REPO_URL" | mask_url)"
info "WEB_CODE_LOCAL_SUBDIR       = $WEB_CODE_LOCAL_SUBDIR"
info "WEB_REMOTE_PATH             = $WEB_REMOTE_PATH"
info "WEB_REMOTE_DELETE           = $WEB_REMOTE_DELETE"
info "SCRIPT_SOURCE_LOCAL_SUBDIR  = $SCRIPT_SOURCE_LOCAL_SUBDIR"
info "SCRIPT_REMOTE_PATH          = $SCRIPT_REMOTE_PATH"
info "SCRIPT_REMOTE_DELETE        = $SCRIPT_REMOTE_DELETE"
info "SCRIPT_DIR_MODE             = $SCRIPT_DIR_MODE"
info "SCRIPT_FILE_MODE            = $SCRIPT_FILE_MODE"
info "JARVIS_srv_SSH              = ${JARVIS_srv_SSH:-}"
info "JARVIS_srv_USER             = ${JARVIS_srv_USER:-}"
info "SSH_AUTH_MODE               = $SSH_AUTH_MODE"
info "PORTAINER_USE_STACK_WEBHOOK = $PORTAINER_USE_STACK_WEBHOOK"
if has_portainer_redeploy_config; then
  info "PORTAINER_REDEPLOY_MODE     = api"
else
  info "PORTAINER_REDEPLOY_MODE     = webhook"
fi
info "JARVIS_TOOLS_CONTAINER_NAME = $JARVIS_TOOLS_CONTAINER_NAME"
info "PORTAINER_WAIT_SECONDS      = $PORTAINER_REDEPLOY_WAIT_SECONDS"
info "PORTAINER_API_FALLBACK      = $PORTAINER_API_FALLBACK_TO_REMOTE_COMPOSE"
info "RESTART_STRATEGY            = $RESTART_STRATEGY"
info "NPM_INSTALL_CMD             = $NPM_INSTALL_CMD"
info "NPM_BUILD_CMD               = $NPM_BUILD_CMD"
info "NPM_ALLOW_FALLBACK_INSTALL  = $NPM_ALLOW_FALLBACK_INSTALL"
info "STOP_ON_LOCK_MISMATCH       = $STOP_ON_LOCK_MISMATCH"
substep_next "resume de configuration"

step_ok "Pré-checks terminés"

########################################
# Sync GitHub -> local
########################################

if phase_enabled "sync"; then
  step_start "sync"
  cd "$JARVIS_LOCAL_REPO"

  substep_next "inspection du depot local"
  run git -c safe.directory="$JARVIS_LOCAL_REPO" status --short || true
  print_git_remotes_masked

  substep_next "configuration du remote github"
  if git -c safe.directory="$JARVIS_LOCAL_REPO" remote get-url "$GITHUB_REMOTE_NAME" >/dev/null 2>&1; then
    run_sensitive \
      "git remote set-url $GITHUB_REMOTE_NAME $(printf '%s\n' "$GITHUB_REPO_URL" | mask_url)" \
      git -c safe.directory="$JARVIS_LOCAL_REPO" remote set-url "$GITHUB_REMOTE_NAME" "$GITHUB_REPO_URL"
  else
    run_sensitive \
      "git remote add $GITHUB_REMOTE_NAME $(printf '%s\n' "$GITHUB_REPO_URL" | mask_url)" \
      git -c safe.directory="$JARVIS_LOCAL_REPO" remote add "$GITHUB_REMOTE_NAME" "$GITHUB_REPO_URL"
  fi

  info "Remote GitHub utilisé : $GITHUB_REMOTE_NAME"
  info "URL GitHub effective  : $(git -c safe.directory="$JARVIS_LOCAL_REPO" remote get-url "$GITHUB_REMOTE_NAME" | mask_url)"

  LOCAL_COMMIT_BEFORE="$(git -c safe.directory="$JARVIS_LOCAL_REPO" rev-parse HEAD)"
  info "Commit local avant sync : $LOCAL_COMMIT_BEFORE"

  substep_next "fetch github"
  run git -c safe.directory="$JARVIS_LOCAL_REPO" fetch --prune --prune-tags "$GITHUB_REMOTE_NAME" "+refs/heads/*:refs/remotes/$GITHUB_REMOTE_NAME/*" --tags

  git -c safe.directory="$JARVIS_LOCAL_REPO" rev-parse --verify "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH" >/dev/null 2>&1 \
    || die "Branche distante introuvable: $GITHUB_REMOTE_NAME/$JARVIS_BRANCH" "$EXIT_GIT"

  REMOTE_COMMIT="$(git -c safe.directory="$JARVIS_LOCAL_REPO" rev-parse "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH")"
  info "Commit GitHub visé       : $REMOTE_COMMIT"

  substep_next "alignement sur la branche cible"
  run git -c safe.directory="$JARVIS_LOCAL_REPO" checkout -B "$JARVIS_BRANCH" "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH"
  run git -c safe.directory="$JARVIS_LOCAL_REPO" reset --hard "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH"
  run git -c safe.directory="$JARVIS_LOCAL_REPO" clean -fd

  substep_next "submodules et lfs"
  if [[ -f .gitmodules ]]; then
    run git -c safe.directory="$JARVIS_LOCAL_REPO" submodule sync --recursive
    run git -c safe.directory="$JARVIS_LOCAL_REPO" submodule update --init --recursive
  else
    info "Aucun .gitmodules détecté"
  fi

  if git lfs version >/dev/null 2>&1; then
    run git -c safe.directory="$JARVIS_LOCAL_REPO" lfs pull
  else
    info "Git LFS non détecté"
  fi

  LOCAL_COMMIT_AFTER="$(git -c safe.directory="$JARVIS_LOCAL_REPO" rev-parse HEAD)"
  info "Commit local après sync : $LOCAL_COMMIT_AFTER"

  substep_next "verification finale"
  run git -c safe.directory="$JARVIS_LOCAL_REPO" --no-pager log --oneline -n 3
  step_ok "Synchronisation GitHub -> local OK"
fi

########################################
# Install deps
########################################

if phase_enabled "install"; then
  step_start "install"
  cd "$JARVIS_LOCAL_REPO"
  substep_next "preparation npm"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] Installation npm simulée"
  else
    substep_next "installation des dependances"
    run_npm_install_phase
  fi

  step_ok "Installation dépendances OK"
fi

########################################
# Build
########################################

if phase_enabled "build"; then
  step_start "build"
  cd "$JARVIS_LOCAL_REPO"
  substep_next "build typescript"
  run_shell "$NPM_BUILD_CMD"
  step_ok "Build OK"
fi

########################################
# Deploy web
########################################

if phase_enabled "deploy-web"; then
  step_start "deploy-web"
  cd "$JARVIS_LOCAL_REPO"
  deploy_web_code
  step_ok "Déploiement web OK"
fi

########################################
# Deploy scripts
########################################

if phase_enabled "deploy-scripts"; then
  step_start "deploy-scripts"
  cd "$JARVIS_LOCAL_REPO"
  deploy_scripts_data
  step_ok "Déploiement scripts OK"
fi

########################################
# Mirror
########################################

if phase_enabled "mirror"; then
  step_start "mirror"

  substep_next "preparation du mirror"
  info "SRC_URL = $(printf '%s\n' "$GITHUB_REPO_URL" | mask_url)"
  info "DST_URL = $(printf '%s\n' "$GITEA_REPO_URL" | mask_url)"

  run_internal_git_mirror
  substep_next "verification du mirror"
  step_ok "Mirror GitHub -> Gitea OK"
fi

########################################
# Webhook
########################################

if phase_enabled "webhook"; then
  step_start "webhook"
  substep_next "lecture du conteneur avant redeploy"
  TOOLS_CONTAINER_STARTED_AT_BEFORE="$(get_remote_container_started_at "$JARVIS_TOOLS_CONTAINER_NAME" | tr -d '\r' | tail -n 1)"

  if has_portainer_redeploy_config; then
    substep_next "tentative redeploy portainer"
    redeploy_portainer_stack_by_name
    substep_next "verification du redeploy"
    wait_for_remote_container_redeploy "$JARVIS_TOOLS_CONTAINER_NAME" "$TOOLS_CONTAINER_STARTED_AT_BEFORE" "$PORTAINER_REDEPLOY_WAIT_SECONDS"
    substep_next "redeploy confirme"
    step_ok "Redeploy stack Portainer OK"
  else
    if [[ "$PORTAINER_USE_STACK_WEBHOOK" != "1" ]]; then
      die "Cette V5.6 attend un redeploy Portainer configuré ou PORTAINER_USE_STACK_WEBHOOK=1" "$EXIT_WEBHOOK"
    fi

    substep_next "declenchement du webhook"
    trigger_webhook "$JARVIS_TOOLS_WEBHOOK_URL"
    substep_next "verification du redeploy"
    wait_for_remote_container_redeploy "$JARVIS_TOOLS_CONTAINER_NAME" "$TOOLS_CONTAINER_STARTED_AT_BEFORE" "$PORTAINER_REDEPLOY_WAIT_SECONDS"
    substep_next "redeploy confirme"
    step_ok "Webhook Portainer OK"
  fi
fi

########################################
# Restart MCPO
########################################

if phase_enabled "restart"; then
  step_start "restart"
  substep_next "redemarrage mcpo"
  restart_runtime
  step_ok "Redémarrage MCPO OK"
fi

########################################
# Final summary
########################################

finalize_summary "$EXIT_OK"

log "Terminé"
info "Repo local mis à jour       : ${JARVIS_LOCAL_REPO:-}"
info "Déploiement web SSH         : oui"
info "Déploiement scripts SSH     : oui"
info "Mirror GitHub -> Gitea      : oui"
info "Webhook Portainer déclenché : oui"
info "Conteneur redémarré         : ${JARVIS_MCPO_CONTAINER_NAME:-webhook-managed}"
info "Log                         : $LOG_FILE"
info "Résumé JSON                 : $SUMMARY_JSON"

emit_summary_stdout

exit "$EXIT_OK"
