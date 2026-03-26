#!/usr/bin/env bash
set -Eeuo pipefail

########################################
# Jarvis V5.2
# Sync GitHub -> Build local -> Deploy web code -> Deploy scripts
# -> Mirror Gitea -> Portainer webhook -> Restart MCPO
#
# Improvements over V5.1:
# - deploy tools/scripts to a shared runtime scripts directory
# - verify/fix remote permissions
# - secret-safe logs
# - MCP-ready summary
########################################

########################################
# Globals
########################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE_DEFAULT="$SCRIPT_DIR/.env"
LOG_DIR_DEFAULT="$SCRIPT_DIR/logs"
SUMMARY_DIR_DEFAULT="$SCRIPT_DIR/logs"

ENV_FILE="${ENV_FILE:-$ENV_FILE_DEFAULT}"
LOG_DIR="${LOG_DIR:-$LOG_DIR_DEFAULT}"
SUMMARY_DIR="${SUMMARY_DIR:-$SUMMARY_DIR_DEFAULT}"

mkdir -p "$LOG_DIR" "$SUMMARY_DIR"

RUN_ID="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/jarvis_sync_${RUN_ID}.log"
SUMMARY_JSON="${SUMMARY_DIR}/jarvis_sync_${RUN_ID}.json"

DRY_RUN=0
PHASE="all"
JSON_STDOUT=0
ORIGINAL_STDOUT_FD=3
MCP_PHASE=""
MCP_CONFIRMED="false"
MCP_MODE=""
declare -A MCP_PARAMS=()

CURRENT_STEP=""
CURRENT_STEP_STATUS="pending"

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
    self-doc|registry-doc)
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
    self-doc|registry-doc)
      printf 'false'
      ;;
    *)
      printf 'true'
      ;;
  esac
}

metadata_services_json() {
  local services="self-doc
registry-doc
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
    output+="$(printf '{"name":"%s","phase":"%s","confirmed_required":%s,"description":"%s"}' \
      "$(json_escape_shell "$service")" \
      "$(service_phase "$service")" \
      "$(service_confirmed_required "$service")" \
      "$(json_escape_shell "$(mode_description "$service")")")"
    first=0
  done <<< "$services"

  output+="]"
  printf '%s' "$output"
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
    "version":"1.0.0",
    "supports_registry":true,
    "required_env":[
      {"name":"jarvis_tools_GITHUB_TOKEN","required":true,"secret":true,"description":"GitHub token used for sync and mirror."},
      {"name":"jarvis_tools_GITEA_TOKEN","required":true,"secret":true,"description":"Gitea token used for mirror."},
      {"name":"JARVIS_LOCAL_REPO","required":true,"secret":false,"description":"Local repository path."},
      {"name":"JARVIS_MIRROR_SCRIPT","required":true,"secret":false,"description":"Mirror helper script path."},
      {"name":"JARVIS_TOOLS_WEBHOOK_URL","required":true,"secret":true,"description":"Portainer webhook URL."},
      {"name":"JARVIS_MCPO_CONTAINER_NAME","required":true,"secret":false,"description":"MCPO container name."},
      {"name":"JARVIS_srv_SSH","required":true,"secret":false,"description":"SSH host and port for deploy target."},
      {"name":"JARVIS_srv_USER","required":true,"secret":false,"description":"SSH user for deploy target."}
    ],
    "services":%s,
    "capabilities":["git-sync","npm-install","build","deploy-web","deploy-scripts","mirror","webhook","docker-restart"],
    "tags":["jarvis","deploy","build","mcp","automation"]
  },
  "runtime":{
    "accepted_phase_values":["collect","execute"],
    "accepted_params":["mode","dry_run","env_file"],
    "legacy_options":["--phase","--dry-run","--env","--json-stdout"]
  },
  "summary":"Jarvis sync/build/redeploy workflow self-documentation"
}' \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "Synchronize source, build locally, deploy web code and scripts, mirror refs, trigger webhook, and restart MCPO.")" \
    "$(metadata_services_json)")"
}

registry_doc_json() {
  local file_name
  file_name="$(basename "${BASH_SOURCE[0]}")"
  emit_mcp_json "$(printf '{"ok":true,"mode":"registry-doc","script":{"script_name":"%s","file_name":"%s","description":"%s","version":"1.0.0","required_env":[{"name":"jarvis_tools_GITHUB_TOKEN","required":true,"secret":true,"description":"GitHub token used for sync and mirror."},{"name":"jarvis_tools_GITEA_TOKEN","required":true,"secret":true,"description":"Gitea token used for mirror."},{"name":"JARVIS_LOCAL_REPO","required":true,"secret":false,"description":"Local repository path."},{"name":"JARVIS_MIRROR_SCRIPT","required":true,"secret":false,"description":"Mirror helper script path."},{"name":"JARVIS_TOOLS_WEBHOOK_URL","required":true,"secret":true,"description":"Portainer webhook URL."},{"name":"JARVIS_MCPO_CONTAINER_NAME","required":true,"secret":false,"description":"MCPO container name."},{"name":"JARVIS_srv_SSH","required":true,"secret":false,"description":"SSH host and port for deploy target."},{"name":"JARVIS_srv_USER","required":true,"secret":false,"description":"SSH user for deploy target."}],"supports_registry":true,"services":%s,"capabilities":["git-sync","npm-install","build","deploy-web","deploy-scripts","mirror","webhook","docker-restart"],"tags":["jarvis","deploy","build","mcp","automation"]}}' \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "$file_name")" \
    "$(json_escape_shell "Synchronize source, build locally, deploy web code and scripts, mirror refs, trigger webhook, and restart MCPO.")" \
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
    self-doc)
      [[ "$MCP_PHASE" == "collect" ]] || emit_mcp_error "Invalid phase for mode" "Mode self-doc requires phase=collect" "self-doc"
      self_doc_json
      exit 0
      ;;
    registry-doc)
      [[ "$MCP_PHASE" == "collect" ]] || emit_mcp_error "Invalid phase for mode" "Mode registry-doc requires phase=collect" "registry-doc"
      registry_doc_json
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
    cat "$SUMMARY_JSON" >&${ORIGINAL_STDOUT_FD}
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

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Commande absente: $1" "$EXIT_ENV"
}

mask_url() {
  sed -E 's#(https?://)[^/@]+@#\1***@#g'
}

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

########################################
# Summary / step tracking
########################################

STEP_RESULTS=()

step_start() {
  CURRENT_STEP="$1"
  CURRENT_STEP_STATUS="running"
  log "STEP START: $CURRENT_STEP"
}

step_ok() {
  local msg="${1:-OK}"
  CURRENT_STEP_STATUS="ok"
  STEP_RESULTS+=("{\"step\":\"$CURRENT_STEP\",\"status\":\"ok\",\"message\":$(json_escape "$msg")}")
  info "STEP OK: $CURRENT_STEP - $msg"
}

step_fail() {
  local msg="${1:-FAILED}"
  CURRENT_STEP_STATUS="failed"
  STEP_RESULTS+=("{\"step\":\"$CURRENT_STEP\",\"status\":\"failed\",\"message\":$(json_escape "$msg")}")
  error "STEP FAIL: $CURRENT_STEP - $msg"
}

finalize_summary() {
  local exit_code="${1:-0}"
  local steps_json
  if [[ ${#STEP_RESULTS[@]} -eq 0 ]]; then
    steps_json="[]"
  else
    local joined
    joined="$(IFS=,; echo "${STEP_RESULTS[*]}")"
    steps_json="[$joined]"
  fi

  cat > "$SUMMARY_JSON" <<EOF
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
}

on_error() {
  local line_no="${1:-unknown}"
  local exit_code=$?
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

exec 3>&1
if [[ "$JSON_STDOUT" == "1" ]]; then
  exec > >(tee -a "$LOG_FILE" >&2) 2>&1
else
  exec > >(tee -a "$LOG_FILE") 2>&1
fi

########################################
# Load env
########################################

[[ -f "$ENV_FILE" ]] || die "Fichier .env introuvable : $ENV_FILE" "$EXIT_ENV"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

########################################
# Required env vars
########################################

: "${jarvis_tools_GITHUB_TOKEN:?Variable manquante: jarvis_tools_GITHUB_TOKEN}"
: "${jarvis_tools_GITEA_TOKEN:?Variable manquante: jarvis_tools_GITEA_TOKEN}"
: "${JARVIS_LOCAL_REPO:?Variable manquante: JARVIS_LOCAL_REPO}"
: "${JARVIS_MIRROR_SCRIPT:?Variable manquante: JARVIS_MIRROR_SCRIPT}"
: "${JARVIS_TOOLS_WEBHOOK_URL:?Variable manquante: JARVIS_TOOLS_WEBHOOK_URL}"
: "${JARVIS_MCPO_CONTAINER_NAME:?Variable manquante: JARVIS_MCPO_CONTAINER_NAME}"

: "${JARVIS_srv_SSH:?Variable manquante: JARVIS_srv_SSH}"
: "${JARVIS_srv_USER:?Variable manquante: JARVIS_srv_USER}"

########################################
# Default params
########################################

JARVIS_BRANCH="${JARVIS_BRANCH:-main}"

NPM_INSTALL_CMD="${NPM_INSTALL_CMD:-npm ci}"
NPM_BUILD_CMD="${NPM_BUILD_CMD:-npm run build}"
NPM_FALLBACK_INSTALL_CMD="${NPM_FALLBACK_INSTALL_CMD:-npm install}"
NPM_ALLOW_FALLBACK_INSTALL="${NPM_ALLOW_FALLBACK_INSTALL:-0}"
STOP_ON_LOCK_MISMATCH="${STOP_ON_LOCK_MISMATCH:-1}"

GITHUB_REPO_URL="${GITHUB_REPO_URL:-https://${jarvis_tools_GITHUB_TOKEN}@github.com/papapingouin-be/jarvis-mcp.git}"
GITEA_REPO_URL="${GITEA_REPO_URL:-https://${jarvis_tools_GITEA_TOKEN}@webgit.jarvis.papapingouinbe.duckdns.org/jarvisadmin/jarvis-mcp-tools.git}"
GITHUB_REMOTE_NAME="${GITHUB_REMOTE_NAME:-github-src}"

WEB_CODE_LOCAL_SUBDIR="${WEB_CODE_LOCAL_SUBDIR:-jarvis-config-web}"
WEB_REMOTE_PATH="${WEB_REMOTE_PATH:-/opt/jarvis/config-web}"
WEB_REMOTE_DELETE="${WEB_REMOTE_DELETE:-1}"

SCRIPT_SOURCE_LOCAL_SUBDIR="${SCRIPT_SOURCE_LOCAL_SUBDIR:-tools/scripts}"
SCRIPT_REMOTE_PATH="${SCRIPT_REMOTE_PATH:-/opt/jarvis/shared/scripts}"
SCRIPT_REMOTE_DELETE="${SCRIPT_REMOTE_DELETE:-1}"
SCRIPT_DIR_MODE="${SCRIPT_DIR_MODE:-755}"
SCRIPT_FILE_MODE="${SCRIPT_FILE_MODE:-644}"

PORTAINER_USE_STACK_WEBHOOK="${PORTAINER_USE_STACK_WEBHOOK:-1}"

USE_SUDO="${USE_SUDO:-1}"

########################################
# Helpers
########################################

phase_enabled() {
  local wanted="$1"
  [[ "$PHASE" == "all" || "$PHASE" == "$wanted" ]]
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
    remote_url="$(git remote get-url "$remote_name" | mask_url)"
    info "  - $remote_name => $remote_url"
  done < <(git remote)
}

detect_ssh_auth_mode() {
  if command -v sshpass >/dev/null 2>&1 && [[ -n "${JARVIS_srv_PSWD:-}" ]]; then
    SSH_AUTH_MODE="sshpass"
    return 0
  fi

  if [[ -n "${JARVIS_SSH_KEY_PATH:-}" ]]; then
    [[ -f "$JARVIS_SSH_KEY_PATH" ]] || die "Clé SSH introuvable: $JARVIS_SSH_KEY_PATH" "$EXIT_DEPLOY_WEB"
    SSH_AUTH_MODE="keyfile"
    return 0
  fi

  if [[ -f "$HOME/.ssh/id_rsa" || -f "$HOME/.ssh/id_ed25519" ]]; then
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

rsync_copy_dir() {
  local source_path="$1"
  local remote_path="$2"
  local delete_mode="$3"
  local exit_code="$4"

  local host port
  host="$(ssh_host)"
  port="$(ssh_port)"

  [[ -d "$source_path" ]] || die "Source introuvable: $source_path" "$exit_code"

  local rsync_delete_arg=()
  if [[ "$delete_mode" == "1" ]]; then
    rsync_delete_arg+=(--delete)
  fi

  remote_exec "mkdir -p '$remote_path'"

  case "$SSH_AUTH_MODE" in
    sshpass)
      run_sensitive \
        "sshpass rsync -avz ${rsync_delete_arg[*]:-} -e 'ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null' ${source_path}/ ${JARVIS_srv_USER}@${host}:${remote_path}/" \
        env SSHPASS="$JARVIS_srv_PSWD" sshpass -e rsync -avz \
          "${rsync_delete_arg[@]}" \
          -e "ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
          "${source_path}/" \
          "${JARVIS_srv_USER}@${host}:${remote_path}/"
      ;;
    keyfile)
      run rsync -avz \
        "${rsync_delete_arg[@]}" \
        -e "ssh -i $JARVIS_SSH_KEY_PATH -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
        "${source_path}/" \
        "${JARVIS_srv_USER}@${host}:${remote_path}/"
      ;;
    agent_or_default_key)
      run rsync -avz \
        "${rsync_delete_arg[@]}" \
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

  info "Source locale web      = $source_path"
  info "Serveur distant        = ${JARVIS_srv_USER}@$(mask_host "$JARVIS_srv_SSH")"
  info "Destination web        = $WEB_REMOTE_PATH"
  info "Mode auth SSH          = $SSH_AUTH_MODE"

  rsync_copy_dir "$source_path" "$WEB_REMOTE_PATH" "$WEB_REMOTE_DELETE" "$EXIT_DEPLOY_WEB"
}

deploy_scripts_data() {
  local source_path
  source_path="${JARVIS_LOCAL_REPO%/}/${SCRIPT_SOURCE_LOCAL_SUBDIR}"

  info "Source locale scripts  = $source_path"
  info "Serveur distant        = ${JARVIS_srv_USER}@$(mask_host "$JARVIS_srv_SSH")"
  info "Destination scripts    = $SCRIPT_REMOTE_PATH"
  info "Mode auth SSH          = $SSH_AUTH_MODE"

  rsync_copy_dir "$source_path" "$SCRIPT_REMOTE_PATH" "$SCRIPT_REMOTE_DELETE" "$EXIT_DEPLOY_SCRIPTS"
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

need_cmd git
need_cmd npm
need_cmd curl
need_cmd bash
need_cmd ssh
need_cmd rsync
need_cmd python3
need_cmd docker

[[ -d "$JARVIS_LOCAL_REPO/.git" ]] || die "Repo local introuvable: $JARVIS_LOCAL_REPO/.git" "$EXIT_ENV"
[[ -x "$JARVIS_MIRROR_SCRIPT" ]] || die "Script mirror introuvable ou non exécutable: $JARVIS_MIRROR_SCRIPT" "$EXIT_ENV"

detect_ssh_auth_mode

info "ENV_FILE                    = $ENV_FILE"
info "LOG_FILE                    = $LOG_FILE"
info "SUMMARY_JSON                = $SUMMARY_JSON"
info "PHASE                       = $PHASE"
info "DRY_RUN                     = $DRY_RUN"
info "JSON_STDOUT                 = $JSON_STDOUT"
info "USE_SUDO                    = $USE_SUDO"
info "JARVIS_LOCAL_REPO           = $JARVIS_LOCAL_REPO"
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
info "JARVIS_srv_SSH              = $JARVIS_srv_SSH"
info "JARVIS_srv_USER             = $JARVIS_srv_USER"
info "SSH_AUTH_MODE               = $SSH_AUTH_MODE"
info "PORTAINER_USE_STACK_WEBHOOK = $PORTAINER_USE_STACK_WEBHOOK"
info "NPM_INSTALL_CMD             = $NPM_INSTALL_CMD"
info "NPM_BUILD_CMD               = $NPM_BUILD_CMD"
info "NPM_ALLOW_FALLBACK_INSTALL  = $NPM_ALLOW_FALLBACK_INSTALL"
info "STOP_ON_LOCK_MISMATCH       = $STOP_ON_LOCK_MISMATCH"

step_ok "Pré-checks terminés"

########################################
# Sync GitHub -> local
########################################

if phase_enabled "sync"; then
  step_start "sync"
  cd "$JARVIS_LOCAL_REPO"

  run git status --short || true
  print_git_remotes_masked

  if git remote get-url "$GITHUB_REMOTE_NAME" >/dev/null 2>&1; then
    run_sensitive \
      "git remote set-url $GITHUB_REMOTE_NAME $(printf '%s\n' "$GITHUB_REPO_URL" | mask_url)" \
      git remote set-url "$GITHUB_REMOTE_NAME" "$GITHUB_REPO_URL"
  else
    run_sensitive \
      "git remote add $GITHUB_REMOTE_NAME $(printf '%s\n' "$GITHUB_REPO_URL" | mask_url)" \
      git remote add "$GITHUB_REMOTE_NAME" "$GITHUB_REPO_URL"
  fi

  info "Remote GitHub utilisé : $GITHUB_REMOTE_NAME"
  info "URL GitHub effective  : $(git remote get-url "$GITHUB_REMOTE_NAME" | mask_url)"

  LOCAL_COMMIT_BEFORE="$(git rev-parse HEAD)"
  info "Commit local avant sync : $LOCAL_COMMIT_BEFORE"

  run git fetch --prune --prune-tags "$GITHUB_REMOTE_NAME" "+refs/heads/*:refs/remotes/$GITHUB_REMOTE_NAME/*" --tags

  git rev-parse --verify "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH" >/dev/null 2>&1 \
    || die "Branche distante introuvable: $GITHUB_REMOTE_NAME/$JARVIS_BRANCH" "$EXIT_GIT"

  REMOTE_COMMIT="$(git rev-parse "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH")"
  info "Commit GitHub visé       : $REMOTE_COMMIT"

  run git checkout -B "$JARVIS_BRANCH" "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH"
  run git reset --hard "$GITHUB_REMOTE_NAME/$JARVIS_BRANCH"
  run git clean -fd

  if [[ -f .gitmodules ]]; then
    run git submodule sync --recursive
    run git submodule update --init --recursive
  else
    info "Aucun .gitmodules détecté"
  fi

  if git lfs version >/dev/null 2>&1; then
    run git lfs pull
  else
    info "Git LFS non détecté"
  fi

  LOCAL_COMMIT_AFTER="$(git rev-parse HEAD)"
  info "Commit local après sync : $LOCAL_COMMIT_AFTER"

  run git --no-pager log --oneline -n 3
  step_ok "Synchronisation GitHub -> local OK"
fi

########################################
# Install deps
########################################

if phase_enabled "install"; then
  step_start "install"
  cd "$JARVIS_LOCAL_REPO"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "[DRY-RUN] Installation npm simulée"
  else
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

  export GITEA_TOKEN="${jarvis_tools_GITEA_TOKEN}"
  export GITHUB_TOKEN="${jarvis_tools_GITHUB_TOKEN}"
  export DST_URL="$GITEA_REPO_URL"
  export SRC_URL="$GITHUB_REPO_URL"
  export MODE="refs"

  info "SRC_URL = $(printf '%s\n' "$SRC_URL" | mask_url)"
  info "DST_URL = $(printf '%s\n' "$DST_URL" | mask_url)"

  run "$JARVIS_MIRROR_SCRIPT"
  step_ok "Mirror GitHub -> Gitea OK"
fi

########################################
# Webhook
########################################

if phase_enabled "webhook"; then
  step_start "webhook"

  if [[ "$PORTAINER_USE_STACK_WEBHOOK" != "1" ]]; then
    die "Cette V5.2 attend PORTAINER_USE_STACK_WEBHOOK=1 pour le redeploy" "$EXIT_WEBHOOK"
  fi

  trigger_webhook "$JARVIS_TOOLS_WEBHOOK_URL"
  step_ok "Webhook Portainer OK"
fi

########################################
# Restart MCPO
########################################

if phase_enabled "restart"; then
  step_start "restart"
  docker_restart_container "$JARVIS_MCPO_CONTAINER_NAME"
  step_ok "Redémarrage MCPO OK"
fi

########################################
# Final summary
########################################

finalize_summary "$EXIT_OK"

log "Terminé"
info "Repo local mis à jour       : $JARVIS_LOCAL_REPO"
info "Déploiement web SSH         : oui"
info "Déploiement scripts SSH     : oui"
info "Mirror GitHub -> Gitea      : oui"
info "Webhook Portainer déclenché : oui"
info "Conteneur redémarré         : $JARVIS_MCPO_CONTAINER_NAME"
info "Log                         : $LOG_FILE"
info "Résumé JSON                 : $SUMMARY_JSON"

emit_summary_stdout

exit "$EXIT_OK"
