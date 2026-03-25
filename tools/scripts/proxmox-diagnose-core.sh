#!/usr/bin/env bash
#===============================================================================
# proxmox-diagnose.sh - V6.2
#
# Mini orchestrateur Proxmox VE via SSH + sudo, orienté CT LXC.
#
# Modes:
#   - self-doc          : retourne uniquement la documentation machine-readable
#   - diagnose          : vérifie SSH, sudo, présence des commandes Proxmox
#   - collect           : collecte templates, storages, bridges, CT/VM existants
#   - preflight-create  : vérifie qu'une création future est faisable
#   - create-ct         : crée un CT, le démarre, post-install réseau, SSH
#   - get-ct-info       : remonte état, nom, config, IP d'un CT
#   - stop-ct           : arrête un CT
#   - destroy-ct        : détruit un CT
#   - ensure-ct         : garantit qu'un CT existe et tourne
#
# Notes:
#   - create-ct / ensure-ct utilisent --password comme mot de passe root du CT
#   - ensure-ct est passif par défaut: crée si absent, démarre si arrêté, lit IP
#   - ensure-ct --reconfigure rejoue post-install réseau + install SSH
#   - vm create n'est pas encore implémenté dans cette version
#   - JSON pretty dépend de python3 -m json.tool
#===============================================================================

set -Eeuo pipefail

#------------------------------------------------------------------------------
# Meta
#------------------------------------------------------------------------------
SCRIPT_VERSION="6.2"
SCRIPT_NAME="proxmox-diagnose.sh"

SUPPORTED_MODES=(
  "self-doc"
  "diagnose"
  "collect"
  "preflight-create"
  "create-ct"
  "get-ct-info"
  "stop-ct"
  "destroy-ct"
  "ensure-ct"
)

#------------------------------------------------------------------------------
# Paramètres CLI
#------------------------------------------------------------------------------
HOST=""
PORT="22"
USER_NAME=""
PASSWORD=""
IDENTITY_FILE=""
MODE="diagnose"
OUTPUT="json"
VERBOSE=0
TRACE=0
USE_SUDO=0
SSH_TIMEOUT=8
ENSURE_RECONFIGURE=0

REQUEST_TYPE=""
REQUEST_TEMPLATE=""
REQUEST_STORAGE=""
REQUEST_BRIDGE=""
REQUEST_VMID=""
REQUEST_HOSTNAME=""

#------------------------------------------------------------------------------
# Paramètres CT par défaut
#------------------------------------------------------------------------------
CT_CORES="1"
CT_MEMORY="512"
CT_SWAP="512"
CT_DISK_GB="8"
CT_UNPRIVILEGED="1"
CT_FEATURES="nesting=1"
CT_NET_IFACE="eth0"
CT_NET_FIREWALL="1"
CT_NET_TYPE="veth"
CT_OSTYPE="debian"
CT_ARCH=""
INSTALL_SSH=1

#------------------------------------------------------------------------------
# État général
#------------------------------------------------------------------------------
SSH_OK=false
SUDO_OK=false
HOST_IS_PROXMOX=false
LIKELY_WRONG_HOST=false
LIKELY_WRONG_USER_OR_CONTEXT=false
ACL_OR_PERMISSION_ISSUE=false
REQUIRES_ROOT_FOR_PROXMOX_COMMANDS=false

SSH_PROBE_RC=0
SSH_PROBE_STDOUT=""
SSH_PROBE_STDERR=""
SSH_INTERACTIVE_PASSWORD_REQUIRED=false
SSH_HOST_KEY_ISSUE=false
SSH_SENTINEL="__PVE_DIAG_SSH_OK_9f4b2d__"

REMOTE_HOSTNAME=""
REMOTE_OS=""
REMOTE_PATH=""
REMOTE_WHOAMI=""
REMOTE_ID=""
REMOTE_ARCH=""

TEMPLATES=()
LOCAL_TEMPLATES=()
EXISTING_CT=()
EXISTING_VM=()
STORAGES=()
BRIDGES=()
RECOMMENDATIONS=()
COLLECT_WARNINGS=()
COMMANDS_MISSING=()
NEXTID=""

#------------------------------------------------------------------------------
# État preflight
#------------------------------------------------------------------------------
PREFLIGHT_TYPE_VALID=false
PREFLIGHT_TEMPLATE_EXISTS=""
PREFLIGHT_TEMPLATE_AVAILABLE_CATALOG=""
PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL=""
PREFLIGHT_STORAGE_EXISTS=""
PREFLIGHT_BRIDGE_EXISTS=""
PREFLIGHT_VMID_AVAILABLE=true
PREFLIGHT_VMID_SUGGESTED=""
PREFLIGHT_STORAGE_DEFAULT=""
PREFLIGHT_BRIDGE_DEFAULT=""
PREFLIGHT_WARNINGS=()

#------------------------------------------------------------------------------
# État create
#------------------------------------------------------------------------------
CREATE_OK=false
CREATE_CREATED=false
CREATE_STARTED=false
CREATE_TEMPLATE_DOWNLOADED=false
CREATE_POSTINSTALL_OK=false
CREATE_SSH_OK=false
CREATE_IP=""
CREATE_STATUS=""
CREATE_WARNINGS=()
CREATE_TEMPLATE_SOURCE=""
CREATE_TEMPLATE_VOLUME=""
CREATE_ROOTFS_SPEC=""
CREATE_CT_RC=""
CREATE_CT_OUTPUT=""
START_CT_RC=""
START_CT_OUTPUT=""
POSTINSTALL_RC=""
POSTINSTALL_OUTPUT=""
INSTALL_SSH_RC=""
INSTALL_SSH_OUTPUT=""

#------------------------------------------------------------------------------
# État get-ct-info
#------------------------------------------------------------------------------
INFO_OK=false
INFO_EXISTS=false
INFO_STATUS=""
INFO_IP=""
INFO_NAME=""
INFO_CONFIG=""
INFO_RC=""
INFO_OUTPUT=""
INFO_WARNINGS=()

#------------------------------------------------------------------------------
# État stop
#------------------------------------------------------------------------------
STOP_OK=false
STOP_EXISTS=false
STOP_PREV_STATUS=""
STOP_FINAL_STATUS=""
STOP_RC=""
STOP_OUTPUT=""
STOP_WARNINGS=()

#------------------------------------------------------------------------------
# État destroy
#------------------------------------------------------------------------------
DESTROY_OK=false
DESTROY_EXISTS=false
DESTROY_STOPPED=false
DESTROY_RC=""
DESTROY_OUTPUT=""
DESTROY_WARNINGS=()

#------------------------------------------------------------------------------
# État ensure
#------------------------------------------------------------------------------
ENSURE_OK=false
ENSURE_EXISTS=false
ENSURE_CREATED=false
ENSURE_STARTED=false
ENSURE_IP=""
ENSURE_STATUS=""
ENSURE_POSTINSTALL_OK=false
ENSURE_SSH_OK=false
ENSURE_WARNINGS=()

#------------------------------------------------------------------------------
# Maps des commandes
#------------------------------------------------------------------------------
declare -A CMD_FOUND=()
declare -A CMD_RC=()
declare -A CMD_STDOUT=()
declare -A CMD_STDERR=()
declare -A CMD_OUTPUT=()

REMOTE_STDOUT=""
REMOTE_STDERR=""
REMOTE_RC=0
LAST_REMOTE_CMD=""

#------------------------------------------------------------------------------
# Script post-install injecté dans le CT
#------------------------------------------------------------------------------
CT_POSTINSTALL_SCRIPT="$(cat <<'EOSCRIPT'
#!/usr/bin/env bash
set -euo pipefail

IFACE="eth0"
SYSCTL_FILE="/etc/sysctl.d/99-disable-ipv6.conf"
INTERFACES_FILE="/etc/network/interfaces"
NETWORKD_FILE="/etc/systemd/network/10-${IFACE}.network"

echo "[INFO] Vérification interface ${IFACE}"
ip link show "${IFACE}" >/dev/null 2>&1

echo "[INFO] Désactivation IPv6"
mkdir -p /etc/sysctl.d
cat > "${SYSCTL_FILE}" <<POSTCFG
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
net.ipv6.conf.${IFACE}.disable_ipv6 = 1
POSTCFG

sysctl --system >/dev/null 2>&1 || true

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^systemd-networkd\.service'; then
    echo "[INFO] systemd-networkd détecté"
    mkdir -p /etc/systemd/network

    if [ -f "${NETWORKD_FILE}" ]; then
        cp -a "${NETWORKD_FILE}" "${NETWORKD_FILE}.bak.$(date +%Y%m%d_%H%M%S)" || true
    fi

    cat > "${NETWORKD_FILE}" <<NETCFG
[Match]
Name=${IFACE}

[Network]
DHCP=ipv4
LinkLocalAddressing=no
IPv6AcceptRA=no

[DHCPv4]
RouteMetric=100
UseDNS=yes
NETCFG

    systemctl enable systemd-networkd >/dev/null 2>&1 || true
    systemctl restart systemd-networkd || true
else
    echo "[INFO] systemd-networkd non disponible, bascule sur ifupdown"

    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y ifupdown isc-dhcp-client >/dev/null 2>&1 || true

    mkdir -p /etc/network

    if [ -f "${INTERFACES_FILE}" ]; then
        cp -a "${INTERFACES_FILE}" "${INTERFACES_FILE}.bak.$(date +%Y%m%d_%H%M%S)" || true
    fi

    cat > "${INTERFACES_FILE}" <<IFCFG
auto lo
iface lo inet loopback

auto ${IFACE}
iface ${IFACE} inet dhcp
IFCFG

    ifdown "${IFACE}" --force || true
    ifup "${IFACE}" || true
fi

echo "[INFO] Reset interface"
ip addr flush dev "${IFACE}" || true
ip link set "${IFACE}" down || true
sleep 1
ip link set "${IFACE}" up || true

for _ in $(seq 1 10); do
    if ip -4 addr show dev "${IFACE}" | grep -q 'inet '; then
        break
    fi
    sleep 1
done

if ! ip -4 addr show dev "${IFACE}" | grep -q 'inet '; then
    if command -v dhclient >/dev/null 2>&1; then
        dhclient -4 "${IFACE}" >/dev/null 2>&1 || true
    fi
fi

for _ in $(seq 1 10); do
    if ip -4 addr show dev "${IFACE}" | grep -q 'inet '; then
        break
    fi
    sleep 1
done

IPV4_ADDR="$(ip -4 -o addr show dev "${IFACE}" | awk '{print $4}' | head -n1 || true)"
DEFAULT_GW="$(ip route | awk '/default/ {print $3; exit}' || true)"

echo "[RESULT] iface=${IFACE}"
echo "[RESULT] ipv4=${IPV4_ADDR}"
echo "[RESULT] gateway=${DEFAULT_GW}"
EOSCRIPT
)"

#------------------------------------------------------------------------------
# Logging / traps
#------------------------------------------------------------------------------
log() {
  local level="$1"
  shift || true
  if [ "$level" = "DEBUG" ] && [ "$VERBOSE" -eq 0 ]; then
    return 0
  fi
  printf '[%s] %s\n' "$level" "$*" >&2
}

error_trap() {
  local rc=$?
  local line="${BASH_LINENO[0]:-unknown}"
  local cmd="${BASH_COMMAND:-unknown}"
  printf '[ERROR] line=%s rc=%s cmd=%s\n' "$line" "$rc" "$cmd" >&2
}

exit_trap() {
  local rc=$?
  if [ "$TRACE" -eq 1 ]; then
    printf '[TRACE] script_exit rc=%s\n' "$rc" >&2
  fi
}

trap error_trap ERR
trap exit_trap EXIT

enable_shell_trace() {
  if [ "$TRACE" -eq 1 ]; then
    export PS4='+ line ${LINENO}: '
    set -x
  fi
}

#------------------------------------------------------------------------------
# Aide
#------------------------------------------------------------------------------
usage() {
  cat >&2 <<'EOUSAGE'
Usage:
  proxmox-diagnose.sh --host HOST --user USER [options]

Modes:
  self-doc
  diagnose
  collect
  preflight-create
  create-ct
  get-ct-info
  stop-ct
  destroy-ct
  ensure-ct

Core options:
  --host HOST
  --port PORT
  --user USER
  --password PASS
  --identity-file PATH
  --mode MODE
  --output json|pretty
  --sudo
  --verbose
  --trace

Object options:
  --type ct|vm
  --template NAME
  --storage NAME
  --bridge NAME
  --vmid ID
  --hostname NAME

CT tuning:
  --cores N
  --memory MB
  --swap MB
  --disk GB
  --install-ssh
  --no-install-ssh

Ensure:
  --reconfigure       with ensure-ct, rerun CT post-install and SSH setup

Other:
  --help
EOUSAGE
}

#------------------------------------------------------------------------------
# Helpers JSON / shell
#------------------------------------------------------------------------------
shell_quote() {
  printf '%q' "$1"
}

json_escape() {
  python3 -c '
import json, sys
data = sys.stdin.read()
data = "".join(ch for ch in data if ord(ch) >= 32 or ch in "\t\n\r")
sys.stdout.write(json.dumps(data)[1:-1])
'
}

truncate_for_json() {
  python3 -c '
import sys
data = sys.stdin.read()
limit = 4000
sys.stdout.write(data[:limit])
'
}

json_escape_truncated() {
  printf '%s' "${1-}" | truncate_for_json | json_escape
}

json_bool() {
  if [ "${1-false}" = true ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

json_nullable_bool() {
  case "${1-}" in
    true|false) json_bool "$1" ;;
    *) printf 'null' ;;
  esac
}

json_array_strings() {
  local first=1
  local item
  printf '['
  for item in "$@"; do
    if [ $first -eq 0 ]; then
      printf ','
    fi
    printf '"%s"' "$(printf '%s' "$item" | json_escape)"
    first=0
  done
  printf ']'
}

emit_docs_json() {
  printf '"docs":{'
  printf '"version":"%s",' "$(printf '%s' "$SCRIPT_VERSION" | json_escape)"
  printf '"script":"%s",' "$(printf '%s' "$SCRIPT_NAME" | json_escape)"
  printf '"supported_modes":'
  json_array_strings "${SUPPORTED_MODES[@]}"
  printf ','

  printf '"mode_descriptions":{'
  printf '"self-doc":"%s",' "$(printf '%s' 'Return only machine-readable documentation without SSH or Proxmox checks.' | json_escape)"
  printf '"diagnose":"%s",' "$(printf '%s' 'Check SSH, sudo, Proxmox commands, and remote context.' | json_escape)"
  printf '"collect":"%s",' "$(printf '%s' 'Collect templates, local templates, storages, bridges, existing CTs and VMs, and nextid when available.' | json_escape)"
  printf '"preflight-create":"%s",' "$(printf '%s' 'Validate whether a future CT or VM creation request looks ready without creating anything.' | json_escape)"
  printf '"create-ct":"%s",' "$(printf '%s' 'Create a CT, start it, optionally configure networking, install OpenSSH, and return detected IPv4.' | json_escape)"
  printf '"get-ct-info":"%s",' "$(printf '%s' 'Read CT status, hostname, config, and detected IPv4.' | json_escape)"
  printf '"stop-ct":"%s",' "$(printf '%s' 'Stop an existing CT.' | json_escape)"
  printf '"destroy-ct":"%s",' "$(printf '%s' 'Stop if needed and destroy an existing CT.' | json_escape)"
  printf '"ensure-ct":"%s"' "$(printf '%s' 'Ensure a CT exists and is running; with --reconfigure it also reruns post-install and SSH setup.' | json_escape)"
  printf '},'

  printf '"supports":{'
  printf '"ct_create":true,'
  printf '"vm_create":false,'
  printf '"template_catalog_lookup":true,'
  printf '"template_local_cache_lookup":true,'
  printf '"root_password_from_ssh_password":true,'
  printf '"ensure_reconfigure_flag":true,'
  printf '"json_pretty_output":true,'
  printf '"sudo_required_for_proxmox_commands":%s' "$(json_bool "$REQUIRES_ROOT_FOR_PROXMOX_COMMANDS")"
  printf '},'

  printf '"parameters":{'
  printf '"core":'; json_array_strings "--host" "--port" "--user" "--password" "--identity-file" "--mode" "--output" "--sudo" "--verbose" "--trace"; printf ','
  printf '"object":'; json_array_strings "--type" "--template" "--storage" "--bridge" "--vmid" "--hostname"; printf ','
  printf '"ct_tuning":'; json_array_strings "--cores" "--memory" "--swap" "--disk" "--install-ssh" "--no-install-ssh"; printf ','
  printf '"ensure":'; json_array_strings "--reconfigure"
  printf '},'

  printf '"notes":'
  json_array_strings \
    "create-ct and ensure-ct currently support only --type ct." \
    "ensure-ct is passive by default: create if absent, start if stopped, then report state and IP." \
    "ensure-ct with --reconfigure reruns CT post-install networking and SSH installation." \
    "The CT root password is set from --password during create-ct." \
    "Large command outputs are truncated in JSON for stability."
  printf '}'
}

#------------------------------------------------------------------------------
# Helpers tableaux / états
#------------------------------------------------------------------------------
add_recommendation() { RECOMMENDATIONS+=("$1"); }
add_collect_warning() { COLLECT_WARNINGS+=("$1"); }
add_preflight_warning() { PREFLIGHT_WARNINGS+=("$1"); }
add_create_warning() { CREATE_WARNINGS+=("$1"); }
add_missing_command() { COMMANDS_MISSING+=("$1"); }
add_info_warning() { INFO_WARNINGS+=("$1"); }
add_stop_warning() { STOP_WARNINGS+=("$1"); }
add_destroy_warning() { DESTROY_WARNINGS+=("$1"); }
add_ensure_warning() { ENSURE_WARNINGS+=("$1"); }

safe_assoc_get() {
  local map_name="$1"
  local key="$2"
  local default_value="${3-}"
  local value=""
  if eval "[[ -v ${map_name}[\"\$key\"] ]]"; then
    eval "value=\${${map_name}[\"\$key\"]}"
    printf '%s' "$value"
  else
    printf '%s' "$default_value"
  fi
}

contains_text() {
  local text="${1-}"
  local pattern="${2-}"
  printf '%s' "$text" | grep -Eqi "$pattern"
}

in_array_exact() {
  local needle="$1"
  shift || true
  local item
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

vmid_exists() {
  local candidate="$1"
  in_array_exact "$candidate" "${EXISTING_CT[@]}" && return 0
  in_array_exact "$candidate" "${EXISTING_VM[@]}" && return 0
  return 1
}

suggest_free_vmid() {
  local id
  for id in $(seq 100 999999); do
    if ! vmid_exists "$id"; then
      printf '%s' "$id"
      return 0
    fi
  done
  return 1
}

choose_default_bridge() {
  if in_array_exact "vmbr0" "${BRIDGES[@]}"; then
    printf 'vmbr0'
    return 0
  fi
  if [ "${#BRIDGES[@]}" -gt 0 ]; then
    printf '%s' "${BRIDGES[0]}"
    return 0
  fi
  return 1
}

choose_default_storage() {
  if in_array_exact "local-lvm" "${STORAGES[@]}"; then
    printf 'local-lvm'
    return 0
  fi
  if in_array_exact "local" "${STORAGES[@]}"; then
    printf 'local'
    return 0
  fi
  if [ "${#STORAGES[@]}" -gt 0 ]; then
    printf '%s' "${STORAGES[0]}"
    return 0
  fi
  return 1
}

detect_ct_arch() {
  if printf '%s' "${REMOTE_ARCH-}" | grep -Eqi 'aarch64|arm64'; then
    printf 'arm64'
  else
    printf 'amd64'
  fi
}

build_ct_rootfs_spec() {
  printf '%s' "${REQUEST_STORAGE}:${CT_DISK_GB}"
}

reset_create_state() {
  CREATE_OK=false
  CREATE_CREATED=false
  CREATE_STARTED=false
  CREATE_TEMPLATE_DOWNLOADED=false
  CREATE_POSTINSTALL_OK=false
  CREATE_SSH_OK=false
  CREATE_IP=""
  CREATE_STATUS=""
  CREATE_WARNINGS=()
  CREATE_TEMPLATE_SOURCE=""
  CREATE_TEMPLATE_VOLUME=""
  CREATE_ROOTFS_SPEC=""
  CREATE_CT_RC=""
  CREATE_CT_OUTPUT=""
  START_CT_RC=""
  START_CT_OUTPUT=""
  POSTINSTALL_RC=""
  POSTINSTALL_OUTPUT=""
  INSTALL_SSH_RC=""
  INSTALL_SSH_OUTPUT=""
}

#------------------------------------------------------------------------------
# Parsing CLI
#------------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --host) HOST="${2-}"; shift 2 ;;
      --port) PORT="${2-}"; shift 2 ;;
      --user) USER_NAME="${2-}"; shift 2 ;;
      --password) PASSWORD="${2-}"; shift 2 ;;
      --identity-file) IDENTITY_FILE="${2-}"; shift 2 ;;
      --mode) MODE="${2-}"; shift 2 ;;
      --output) OUTPUT="${2-}"; shift 2 ;;
      --type) REQUEST_TYPE="${2-}"; shift 2 ;;
      --template) REQUEST_TEMPLATE="${2-}"; shift 2 ;;
      --storage) REQUEST_STORAGE="${2-}"; shift 2 ;;
      --bridge) REQUEST_BRIDGE="${2-}"; shift 2 ;;
      --vmid) REQUEST_VMID="${2-}"; shift 2 ;;
      --hostname) REQUEST_HOSTNAME="${2-}"; shift 2 ;;
      --cores) CT_CORES="${2-}"; shift 2 ;;
      --memory) CT_MEMORY="${2-}"; shift 2 ;;
      --swap) CT_SWAP="${2-}"; shift 2 ;;
      --disk) CT_DISK_GB="${2-}"; shift 2 ;;
      --install-ssh) INSTALL_SSH=1; shift ;;
      --no-install-ssh) INSTALL_SSH=0; shift ;;
      --reconfigure) ENSURE_RECONFIGURE=1; shift ;;
      --sudo) USE_SUDO=1; shift ;;
      --verbose) VERBOSE=1; shift ;;
      --trace) TRACE=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *)
        printf 'Unknown argument: %s\n' "$1" >&2
        usage
        exit 1
        ;;
    esac
  done

  case "${MODE-diagnose}" in
    self-doc)
      :
      ;;
    diagnose|collect|preflight-create|create-ct|get-ct-info|stop-ct|destroy-ct|ensure-ct)
      [ -n "${HOST-}" ] || { printf 'Missing --host\n' >&2; exit 1; }
      [ -n "${USER_NAME-}" ] || { printf 'Missing --user\n' >&2; exit 1; }
      ;;
    *)
      printf 'Invalid --mode: %s\n' "$MODE" >&2
      exit 1
      ;;
  esac

  case "${OUTPUT-json}" in
    json|pretty) ;;
    *)
      printf 'Invalid --output: %s\n' "$OUTPUT" >&2
      exit 1
      ;;
  esac

  case "$MODE" in
    preflight-create|create-ct|ensure-ct)
      case "${REQUEST_TYPE-}" in
        ct|vm) ;;
        *)
          printf 'In --mode %s, --type must be ct or vm\n' "$MODE" >&2
          exit 1
          ;;
      esac
      ;;
  esac

  case "$MODE" in
    get-ct-info|stop-ct|destroy-ct)
      [ -n "${REQUEST_VMID-}" ] || {
        printf 'Missing --vmid for --mode %s\n' "$MODE" >&2
        exit 1
      }
      ;;
  esac

  if [ "$MODE" = "create-ct" ] || [ "$MODE" = "ensure-ct" ]; then
    [ "$REQUEST_TYPE" = "ct" ] || {
      printf '--mode %s currently supports only --type ct\n' "$MODE" >&2
      exit 1
    }
    [ -n "${REQUEST_TEMPLATE-}" ] || {
      printf 'Missing --template for %s\n' "$MODE" >&2
      exit 1
    }
    [ -n "${PASSWORD-}" ] || {
      printf 'Missing --password for %s (used for SSH and CT root password)\n' "$MODE" >&2
      exit 1
    }
  fi

  if [ -n "${REQUEST_VMID-}" ] && ! printf '%s' "$REQUEST_VMID" | grep -Eq '^[0-9]+$'; then
    printf 'Invalid --vmid: %s\n' "$REQUEST_VMID" >&2
    exit 1
  fi

  for n in "$CT_CORES" "$CT_MEMORY" "$CT_SWAP" "$CT_DISK_GB"; do
    printf '%s' "$n" | grep -Eq '^[0-9]+$' || {
      printf 'Invalid numeric CT option value: %s\n' "$n" >&2
      exit 1
    }
  done

  if [ -z "${PASSWORD-}" ] && [ -z "${IDENTITY_FILE-}" ] && [ "$MODE" != "self-doc" ]; then
    add_recommendation "No SSH password or identity file was provided. Non-interactive SSH may fail unless a key is already configured."
  fi
}

#------------------------------------------------------------------------------
# Prérequis locaux
#------------------------------------------------------------------------------
require_local_tools() {
  local tool
  for tool in ssh mktemp grep awk sed python3; do
    command -v "$tool" >/dev/null 2>&1 || {
      printf 'Missing local command: %s\n' "$tool" >&2
      exit 1
    }
  done

  if [ -n "${PASSWORD-}" ]; then
    command -v sshpass >/dev/null 2>&1 || {
      printf '--password provided but sshpass is not installed locally\n' >&2
      exit 1
    }
  fi
}

#------------------------------------------------------------------------------
# SSH / exec distant
#------------------------------------------------------------------------------
build_ssh_cmd() {
  local -a base_cmd
  base_cmd=(
    ssh
    -p "$PORT"
    -o BatchMode=no
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout="$SSH_TIMEOUT"
    -o ServerAliveInterval=5
    -o ServerAliveCountMax=1
    -o LogLevel=ERROR
  )

  if [ -n "${IDENTITY_FILE-}" ]; then
    base_cmd+=(-i "$IDENTITY_FILE")
  fi

  if [ -z "${PASSWORD-}" ]; then
    base_cmd+=(-o NumberOfPasswordPrompts=0)
  fi

  base_cmd+=("${USER_NAME}@${HOST}")

  if [ -n "${PASSWORD-}" ]; then
    printf '%s\0' sshpass -p "$PASSWORD" "${base_cmd[@]}"
  else
    printf '%s\0' "${base_cmd[@]}"
  fi
}

remote_exec() {
  local remote_cmd="$1"
  local out_file err_file
  local -a ssh_cmd
  local wrapped_cmd
  local rc=0

  LAST_REMOTE_CMD="$remote_cmd"
  out_file="$(mktemp)"
  err_file="$(mktemp)"
  mapfile -d '' ssh_cmd < <(build_ssh_cmd)

  wrapped_cmd="env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin bash --noprofile --norc -c $(printf '%q' "$remote_cmd")"

  log DEBUG "REMOTE CMD: $remote_cmd"

  set +e
  if "${ssh_cmd[@]}" "$wrapped_cmd" >"$out_file" 2>"$err_file"; then
    rc=0
  else
    rc=$?
  fi
  set -e

  REMOTE_STDOUT="$(cat "$out_file" 2>/dev/null || true)"
  REMOTE_STDERR="$(cat "$err_file" 2>/dev/null || true)"
  REMOTE_RC="$rc"

  rm -f "$out_file" "$err_file"

  log DEBUG "REMOTE RC=$REMOTE_RC"
  if [ -n "${REMOTE_STDOUT-}" ]; then log DEBUG "REMOTE STDOUT: $REMOTE_STDOUT"; fi
  if [ -n "${REMOTE_STDERR-}" ]; then log DEBUG "REMOTE STDERR: $REMOTE_STDERR"; fi
}

run_check() {
  local key="$1"
  local cmd="$2"

  remote_exec "$cmd"

  CMD_RC["$key"]="$REMOTE_RC"
  CMD_STDOUT["$key"]="${REMOTE_STDOUT-}"
  CMD_STDERR["$key"]="${REMOTE_STDERR-}"

  if [ -n "${REMOTE_STDOUT-}" ] && [ -n "${REMOTE_STDERR-}" ]; then
    CMD_OUTPUT["$key"]="${REMOTE_STDOUT}"$'\n'"--- STDERR ---"$'\n'"${REMOTE_STDERR}"
  elif [ -n "${REMOTE_STDOUT-}" ]; then
    CMD_OUTPUT["$key"]="${REMOTE_STDOUT}"
  else
    CMD_OUTPUT["$key"]="${REMOTE_STDERR-}"
  fi
}

run_check_pve() {
  local key="$1"
  local cmd="$2"

  if [ "$USE_SUDO" -eq 1 ]; then
    run_check "$key" "sudo -n $cmd"
  else
    run_check "$key" "$cmd"
  fi
}

#------------------------------------------------------------------------------
# Phases communes
#------------------------------------------------------------------------------
probe_ssh() {
  log INFO "Testing SSH connectivity to ${USER_NAME}@${HOST}:${PORT}"
  remote_exec "printf '%s\n' '$SSH_SENTINEL'"

  SSH_PROBE_RC="$REMOTE_RC"
  SSH_PROBE_STDOUT="${REMOTE_STDOUT-}"
  SSH_PROBE_STDERR="${REMOTE_STDERR-}"

  if [ "$REMOTE_RC" -eq 0 ] && printf '%s\n' "$SSH_PROBE_STDOUT" | grep -Fq "$SSH_SENTINEL"; then
    SSH_OK=true
    log INFO "SSH connectivity OK"
    return 0
  fi

  SSH_OK=false

  if contains_text "$SSH_PROBE_STDERR" 'Permission denied|password:|read_passphrase|can.t open /dev/tty'; then
    SSH_INTERACTIVE_PASSWORD_REQUIRED=true
  fi
  if contains_text "$SSH_PROBE_STDERR" 'Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED'; then
    SSH_HOST_KEY_ISSUE=true
  fi

  add_recommendation "SSH command did not pass the non-interactive probe."
  add_recommendation "Check host, port, SSH auth method, and local SSH context."

  if [ "$SSH_INTERACTIVE_PASSWORD_REQUIRED" = true ]; then
    add_recommendation "Interactive password authentication appears to be required."
    add_recommendation "Provide --password for testing or --identity-file for proper automation."
  fi

  if [ "$SSH_HOST_KEY_ISSUE" = true ]; then
    add_recommendation "SSH host key verification failed. Check known_hosts."
  fi

  return 1
}

collect_environment() {
  log INFO "Collecting remote environment"

  run_check "hostname" "hostname 2>/dev/null || uname -n"
  REMOTE_HOSTNAME="$(safe_assoc_get CMD_STDOUT hostname "")"

  run_check "whoami" "whoami || true"
  REMOTE_WHOAMI="$(safe_assoc_get CMD_STDOUT whoami "")"

  run_check "id" "id || true"
  REMOTE_ID="$(safe_assoc_get CMD_STDOUT id "")"

  run_check "path" 'printf "%s" "$PATH" || true'
  REMOTE_PATH="$(safe_assoc_get CMD_STDOUT path "")"

  run_check "arch" 'uname -m || true'
  REMOTE_ARCH="$(safe_assoc_get CMD_STDOUT arch "")"

  run_check "os" '
if [ -r /etc/os-release ]; then
  . /etc/os-release
  printf "%s" "${PRETTY_NAME:-unknown}"
else
  uname -a || true
fi
'
  REMOTE_OS="$(safe_assoc_get CMD_STDOUT os "")"
}

check_one_command() {
  local cmd="$1"
  run_check "${cmd}_which" "command -v $cmd"

  if [ "$(safe_assoc_get CMD_RC "${cmd}_which" "1")" -eq 0 ] && [ -n "$(safe_assoc_get CMD_STDOUT "${cmd}_which" "")" ]; then
    CMD_FOUND["$cmd"]=true
  else
    CMD_FOUND["$cmd"]=false
    add_missing_command "$cmd"
  fi
}

check_commands() {
  log INFO "Checking Proxmox command presence"
  local cmd
  for cmd in pveversion pveam pvesm pct qm sudo pvesh ip find ls awk grep sed bash base64; do
    check_one_command "$cmd"
  done
}

check_sudo_for_pve() {
  if [ "$USE_SUDO" -ne 1 ]; then
    SUDO_OK=false
    return 0
  fi

  log INFO "Testing sudo -n for allowed Proxmox command"
  run_check "sudo_probe" "sudo -n pveversion"

  if [ "$(safe_assoc_get CMD_RC sudo_probe "1")" -eq 0 ]; then
    SUDO_OK=true
    REQUIRES_ROOT_FOR_PROXMOX_COMMANDS=true
    return 0
  fi

  SUDO_OK=false
  REQUIRES_ROOT_FOR_PROXMOX_COMMANDS=true
  add_recommendation "sudo -n is not usable for the current Proxmox command set."
  add_recommendation "Check /etc/sudoers.d/jarvis-proxmox on the remote host."
  return 1
}

run_proxmox_commands() {
  log INFO "Running Proxmox diagnostics"

  if [ "$(safe_assoc_get CMD_FOUND pveversion false)" = true ]; then
    run_check_pve "pveversion" "pveversion"
  else
    CMD_RC["pveversion"]=127
    CMD_OUTPUT["pveversion"]="command not found"
  fi

  if [ "$(safe_assoc_get CMD_FOUND pveam false)" = true ]; then
    run_check_pve "pveam" "pveam available --section system"
  else
    CMD_RC["pveam"]=127
    CMD_OUTPUT["pveam"]="command not found"
  fi

  if [ "$(safe_assoc_get CMD_FOUND pvesm false)" = true ]; then
    run_check_pve "pvesm" "pvesm status"
  else
    CMD_RC["pvesm"]=127
    CMD_OUTPUT["pvesm"]="command not found"
  fi

  if [ "$(safe_assoc_get CMD_FOUND pct false)" = true ]; then
    run_check_pve "pct" "pct list"
  else
    CMD_RC["pct"]=127
    CMD_OUTPUT["pct"]="command not found"
  fi

  if [ "$(safe_assoc_get CMD_FOUND qm false)" = true ]; then
    run_check_pve "qm" "qm list"
  else
    CMD_RC["qm"]=127
    CMD_OUTPUT["qm"]="command not found"
  fi
}

collect_nextid() {
  if [ "$(safe_assoc_get CMD_FOUND pvesh false)" != true ]; then
    add_collect_warning "pvesh not found; nextid unavailable."
    return 0
  fi

  run_check_pve "nextid" "pvesh get /cluster/nextid || true"

  if [ "$(safe_assoc_get CMD_RC nextid 1)" -eq 0 ]; then
    NEXTID="$(safe_assoc_get CMD_STDOUT nextid "")"
    if [ -z "$NEXTID" ]; then
      add_collect_warning "nextid returned empty output."
    fi
  else
    add_collect_warning "nextid query failed."
  fi
}

collect_bridges() {
  if [ "$(safe_assoc_get CMD_FOUND ip false)" = true ]; then
    run_check_pve "bridges" "ip -o link show | awk -F': ' '{print \$2}' | sed 's/@.*//' | grep '^vmbr' || true"
  else
    run_check_pve "bridges" "ls /sys/class/net 2>/dev/null | grep '^vmbr' || true"
  fi

  local output line
  output="$(safe_assoc_get CMD_STDOUT bridges "")"
  [ -n "$output" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    BRIDGES+=("$line")
  done <<EOFBR
$output
EOFBR
}

extract_templates() {
  local output line
  output="$(safe_assoc_get CMD_STDOUT pveam "")"
  [ -n "$output" ] || return 0

  while IFS= read -r line; do
    case "$line" in
      ""|NAME*|*----*) continue ;;
    esac
    set -- $line
    if [ $# -ge 2 ] && [ "$1" = "system" ]; then
      TEMPLATES+=("$2")
    fi
  done <<EOFTPL
$output
EOFTPL
}

collect_local_templates() {
  run_check_pve "local_templates" "find /var/lib/vz/template/cache -maxdepth 1 -type f 2>/dev/null | sed 's#.*/##'"

  if [ "$(safe_assoc_get CMD_RC local_templates 1)" -ne 0 ]; then
    case "$MODE" in
      preflight-create) add_preflight_warning "Local template cache lookup failed." ;;
      create-ct|ensure-ct) add_create_warning "Local template cache lookup failed." ;;
    esac
    return 0
  fi

  local output line
  output="$(safe_assoc_get CMD_STDOUT local_templates "")"
  [ -n "$output" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    LOCAL_TEMPLATES+=("$line")
  done <<EOFLOC
$output
EOFLOC
}

extract_existing_ct() {
  local output line
  output="$(safe_assoc_get CMD_STDOUT pct "")"
  [ -n "$output" ] || return 0

  while IFS= read -r line; do
    case "$line" in
      ""|VMID*|*----*) continue ;;
    esac
    set -- $line
    if [ $# -ge 1 ] && printf '%s' "$1" | grep -Eq '^[0-9]+$'; then
      EXISTING_CT+=("$1")
    fi
  done <<EOFCT
$output
EOFCT
}

extract_existing_vm() {
  local output line
  output="$(safe_assoc_get CMD_STDOUT qm "")"
  [ -n "$output" ] || return 0

  while IFS= read -r line; do
    case "$line" in
      ""|VMID*|*----*) continue ;;
    esac
    set -- $line
    if [ $# -ge 1 ] && printf '%s' "$1" | grep -Eq '^[0-9]+$'; then
      EXISTING_VM+=("$1")
    fi
  done <<EOFVM
$output
EOFVM
}

extract_storages() {
  local output line
  output="$(safe_assoc_get CMD_STDOUT pvesm "")"
  [ -n "$output" ] || return 0

  while IFS= read -r line; do
    case "$line" in
      ""|Name*|*----*) continue ;;
    esac
    set -- $line
    if [ $# -ge 1 ]; then
      STORAGES+=("$1")
    fi
  done <<EOFST
$output
EOFST
}

collect_common_inventory() {
  extract_templates
  collect_local_templates || true
  extract_existing_ct
  extract_existing_vm
  extract_storages
  collect_bridges || true
}

#------------------------------------------------------------------------------
# Préflight / template
#------------------------------------------------------------------------------
evaluate_template_flags() {
  PREFLIGHT_TEMPLATE_AVAILABLE_CATALOG=false
  PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL=false

  if in_array_exact "$REQUEST_TEMPLATE" "${TEMPLATES[@]}"; then
    PREFLIGHT_TEMPLATE_AVAILABLE_CATALOG=true
  fi

  if in_array_exact "$REQUEST_TEMPLATE" "${LOCAL_TEMPLATES[@]}"; then
    PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL=true
  fi

  if [ "$PREFLIGHT_TEMPLATE_AVAILABLE_CATALOG" = true ] || [ "$PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL" = true ]; then
    PREFLIGHT_TEMPLATE_EXISTS=true
  else
    PREFLIGHT_TEMPLATE_EXISTS=false
  fi
}

add_arch_warning_if_needed() {
  [ "${REQUEST_TYPE-}" = "ct" ] || return 0
  [ -n "${REQUEST_TEMPLATE-}" ] || return 0

  if printf '%s' "${REMOTE_ARCH-}" | grep -Eqi 'aarch64|arm64'; then
    if printf '%s' "$REQUEST_TEMPLATE" | grep -Eqi 'amd64|x86_64'; then
      if [ "$MODE" = "preflight-create" ]; then
        add_preflight_warning "Requested template appears to target amd64 while the Proxmox node appears to be arm64/aarch64."
      else
        add_create_warning "Requested template appears to target amd64 while the Proxmox node appears to be arm64/aarch64."
      fi
    fi
  fi

  if printf '%s' "${REMOTE_ARCH-}" | grep -Eqi 'amd64|x86_64'; then
    if printf '%s' "$REQUEST_TEMPLATE" | grep -Eqi 'arm64|aarch64'; then
      if [ "$MODE" = "preflight-create" ]; then
        add_preflight_warning "Requested template appears to target arm64/aarch64 while the Proxmox node appears to be amd64/x86_64."
      else
        add_create_warning "Requested template appears to target arm64/aarch64 while the Proxmox node appears to be amd64/x86_64."
      fi
    fi
  fi
}

run_collect_phase() {
  log INFO "Running collect phase"
  collect_nextid || true
  collect_common_inventory
}

run_preflight_create_phase() {
  log INFO "Running preflight-create phase"
  collect_common_inventory

  case "${REQUEST_TYPE-}" in
    ct|vm) PREFLIGHT_TYPE_VALID=true ;;
    *) PREFLIGHT_TYPE_VALID=false ;;
  esac

  if [ -n "${REQUEST_TEMPLATE-}" ]; then
    evaluate_template_flags
    add_arch_warning_if_needed
    if [ "$PREFLIGHT_TEMPLATE_EXISTS" != true ]; then
      add_preflight_warning "Requested template was not found in pveam available or in the local template cache."
    fi
  else
    PREFLIGHT_TEMPLATE_EXISTS=""
    PREFLIGHT_TEMPLATE_AVAILABLE_CATALOG=""
    PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL=""
    if [ "$REQUEST_TYPE" = "ct" ]; then
      add_preflight_warning "No template was provided for CT preflight."
    fi
  fi

  if [ -n "${REQUEST_STORAGE-}" ]; then
    if in_array_exact "$REQUEST_STORAGE" "${STORAGES[@]}"; then
      PREFLIGHT_STORAGE_EXISTS=true
    else
      PREFLIGHT_STORAGE_EXISTS=false
      add_preflight_warning "Requested storage was not found in pvesm status."
    fi
  else
    PREFLIGHT_STORAGE_EXISTS=""
  fi

  if PREFLIGHT_STORAGE_DEFAULT="$(choose_default_storage 2>/dev/null)"; then :; else
    PREFLIGHT_STORAGE_DEFAULT=""
    add_preflight_warning "No default storage could be suggested."
  fi

  if [ -n "${REQUEST_BRIDGE-}" ]; then
    if in_array_exact "$REQUEST_BRIDGE" "${BRIDGES[@]}"; then
      PREFLIGHT_BRIDGE_EXISTS=true
    else
      PREFLIGHT_BRIDGE_EXISTS=false
      add_preflight_warning "Requested bridge was not found on the remote host."
    fi
  else
    PREFLIGHT_BRIDGE_EXISTS=""
  fi

  if PREFLIGHT_BRIDGE_DEFAULT="$(choose_default_bridge 2>/dev/null)"; then :; else
    PREFLIGHT_BRIDGE_DEFAULT=""
    add_preflight_warning "No default bridge could be suggested."
  fi

  if [ -n "${REQUEST_VMID-}" ]; then
    PREFLIGHT_VMID_SUGGESTED="$REQUEST_VMID"
    if vmid_exists "$REQUEST_VMID"; then
      PREFLIGHT_VMID_AVAILABLE=false
      add_preflight_warning "Requested VMID is already in use."
    else
      PREFLIGHT_VMID_AVAILABLE=true
    fi
  else
    if PREFLIGHT_VMID_SUGGESTED="$(suggest_free_vmid 2>/dev/null)"; then
      PREFLIGHT_VMID_AVAILABLE=true
    else
      PREFLIGHT_VMID_SUGGESTED=""
      PREFLIGHT_VMID_AVAILABLE=false
      add_preflight_warning "Could not suggest a free VMID."
    fi
  fi
}

#------------------------------------------------------------------------------
# CT create helpers
#------------------------------------------------------------------------------
resolve_create_ct_defaults() {
  if [ -z "${REQUEST_VMID-}" ]; then
    REQUEST_VMID="$(suggest_free_vmid)"
  fi

  if [ -z "${REQUEST_HOSTNAME-}" ]; then
    REQUEST_HOSTNAME="ct-${REQUEST_VMID}"
  fi

  if [ -z "${REQUEST_STORAGE-}" ]; then
    REQUEST_STORAGE="$(choose_default_storage)"
  fi

  if [ -z "${REQUEST_BRIDGE-}" ]; then
    REQUEST_BRIDGE="$(choose_default_bridge)"
  fi

  CT_ARCH="$(detect_ct_arch)"
}

ensure_template_volume_for_ct() {
  evaluate_template_flags
  add_arch_warning_if_needed

  if [ "$PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL" = true ]; then
    CREATE_TEMPLATE_SOURCE="local-cache"
    CREATE_TEMPLATE_VOLUME="local:vztmpl/${REQUEST_TEMPLATE}"
    return 0
  fi

  if [ "$PREFLIGHT_TEMPLATE_AVAILABLE_CATALOG" = true ]; then
    log INFO "Template not present locally, downloading to local storage"
    run_check_pve "download_template" "pveam download local $(shell_quote "$REQUEST_TEMPLATE")"

    if [ "$(safe_assoc_get CMD_RC download_template 1)" -ne 0 ]; then
      add_create_warning "Template download failed."
      return 1
    fi

    CREATE_TEMPLATE_DOWNLOADED=true
    CREATE_TEMPLATE_SOURCE="catalog-downloaded"
    CREATE_TEMPLATE_VOLUME="local:vztmpl/${REQUEST_TEMPLATE}"
    LOCAL_TEMPLATES+=("$REQUEST_TEMPLATE")
    PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL=true
    PREFLIGHT_TEMPLATE_EXISTS=true
    return 0
  fi

  add_create_warning "Requested template was not found in pveam available or in the local template cache."
  return 1
}

wait_for_ct_status() {
  local wanted="$1"
  local attempts="${2:-15}"
  local current=""
  local i

  for i in $(seq 1 "$attempts"); do
    run_check_pve "ct_status" "pct status $(shell_quote "$REQUEST_VMID") | awk '{print \$2}'"
    current="$(safe_assoc_get CMD_STDOUT ct_status "")"
    CREATE_STATUS="$current"
    [ "$current" = "$wanted" ] && return 0
    sleep 1
  done
  return 1
}

wait_for_ct_ipv4() {
  local attempts="${1:-20}"
  local value=""
  local i

  for i in $(seq 1 "$attempts"); do
    run_check_pve "detect_ip" "pct exec $(shell_quote "$REQUEST_VMID") -- bash -lc $(shell_quote "ip -4 -o addr show dev ${CT_NET_IFACE} | awk '{print \$4}' | head -n1 | cut -d/ -f1")"
    value="$(safe_assoc_get CMD_STDOUT detect_ip "")"
    if [ -n "$value" ]; then
      CREATE_IP="$value"
      return 0
    fi
    sleep 2
  done
  return 1
}

run_ct_postinstall() {
  local encoded
  encoded="$(printf '%s' "$CT_POSTINSTALL_SCRIPT" | base64 | tr -d '\n')"

  run_check_pve "postinstall_ct" "pct exec $(shell_quote "$REQUEST_VMID") -- bash -lc $(shell_quote "printf '%s' '${encoded}' | base64 -d > /root/postinstall-network.sh && chmod +x /root/postinstall-network.sh && /root/postinstall-network.sh")"
  POSTINSTALL_RC="$(safe_assoc_get CMD_RC postinstall_ct 1)"
  POSTINSTALL_OUTPUT="$(safe_assoc_get CMD_OUTPUT postinstall_ct "")"

  if [ "$POSTINSTALL_RC" -eq 0 ]; then
    CREATE_POSTINSTALL_OK=true
  else
    CREATE_POSTINSTALL_OK=false
    add_create_warning "CT post-install network script failed."
    return 1
  fi
}

install_ct_ssh() {
  if [ "$INSTALL_SSH" -ne 1 ]; then
    CREATE_SSH_OK=false
    return 0
  fi

  run_check_pve "install_ssh_ct" "pct exec $(shell_quote "$REQUEST_VMID") -- bash -lc $(shell_quote "export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y openssh-server && (systemctl enable ssh >/dev/null 2>&1 || true) && (systemctl restart ssh || service ssh restart || true)")"
  INSTALL_SSH_RC="$(safe_assoc_get CMD_RC install_ssh_ct 1)"
  INSTALL_SSH_OUTPUT="$(safe_assoc_get CMD_OUTPUT install_ssh_ct "")"

  if [ "$INSTALL_SSH_RC" -eq 0 ]; then
    CREATE_SSH_OK=true
  else
    CREATE_SSH_OK=false
    add_create_warning "OpenSSH installation inside CT failed."
    return 1
  fi
}

run_create_ct_phase() {
  local create_cmd
  log INFO "Running create-ct phase"

  collect_common_inventory
  resolve_create_ct_defaults

  if vmid_exists "$REQUEST_VMID"; then
    add_create_warning "Requested or resolved VMID is already in use."
    CREATE_OK=false
    return 0
  fi

  if ! in_array_exact "$REQUEST_STORAGE" "${STORAGES[@]}"; then
    add_create_warning "Requested or resolved storage was not found."
    CREATE_OK=false
    return 0
  fi

  if ! in_array_exact "$REQUEST_BRIDGE" "${BRIDGES[@]}"; then
    add_create_warning "Requested or resolved bridge was not found."
    CREATE_OK=false
    return 0
  fi

  if ! ensure_template_volume_for_ct; then
    CREATE_OK=false
    return 0
  fi

  CREATE_ROOTFS_SPEC="$(build_ct_rootfs_spec)"

  create_cmd="pct create $(shell_quote "$REQUEST_VMID") $(shell_quote "$CREATE_TEMPLATE_VOLUME") --arch $(shell_quote "$CT_ARCH") --hostname $(shell_quote "$REQUEST_HOSTNAME") --cores $(shell_quote "$CT_CORES") --memory $(shell_quote "$CT_MEMORY") --swap $(shell_quote "$CT_SWAP") --rootfs $(shell_quote "$CREATE_ROOTFS_SPEC") --net0 $(shell_quote "name=${CT_NET_IFACE},bridge=${REQUEST_BRIDGE},firewall=${CT_NET_FIREWALL},type=${CT_NET_TYPE}") --unprivileged $(shell_quote "$CT_UNPRIVILEGED") --features $(shell_quote "$CT_FEATURES") --ostype $(shell_quote "$CT_OSTYPE") --password $(shell_quote "$PASSWORD")"

  log INFO "Creating CT ${REQUEST_VMID}"
  run_check_pve "create_ct" "$create_cmd"
  CREATE_CT_RC="$(safe_assoc_get CMD_RC create_ct 1)"
  CREATE_CT_OUTPUT="$(safe_assoc_get CMD_OUTPUT create_ct "")"

  if [ "$CREATE_CT_RC" -ne 0 ]; then
    add_create_warning "pct create failed."
    CREATE_OK=false
    return 0
  fi

  CREATE_CREATED=true

  log INFO "Starting CT ${REQUEST_VMID}"
  run_check_pve "start_ct" "pct start $(shell_quote "$REQUEST_VMID")"
  START_CT_RC="$(safe_assoc_get CMD_RC start_ct 1)"
  START_CT_OUTPUT="$(safe_assoc_get CMD_OUTPUT start_ct "")"

  if [ "$START_CT_RC" -ne 0 ]; then
    add_create_warning "pct start failed."
    CREATE_OK=false
    return 0
  fi

  if wait_for_ct_status "running" 20; then
    CREATE_STARTED=true
  else
    add_create_warning "CT did not reach running state in time."
    CREATE_OK=false
    return 0
  fi

  log INFO "Running CT network post-install"
  run_ct_postinstall || true

  log INFO "Installing OpenSSH in CT"
  install_ct_ssh || true

  log INFO "Waiting for CT IPv4"
  if ! wait_for_ct_ipv4 20; then
    add_create_warning "CT IPv4 address was not detected in time."
  fi

  CREATE_OK=true
}

#------------------------------------------------------------------------------
# CT info / stop / destroy / ensure
#------------------------------------------------------------------------------
run_get_ct_info_phase() {
  log INFO "Running get-ct-info phase"
  collect_common_inventory

  if ! vmid_exists "$REQUEST_VMID"; then
    INFO_EXISTS=false
    INFO_OK=false
    add_info_warning "CT/VMID not found."
    return 0
  fi

  if ! in_array_exact "$REQUEST_VMID" "${EXISTING_CT[@]}"; then
    INFO_EXISTS=false
    INFO_OK=false
    add_info_warning "Requested VMID exists but is not a CT."
    return 0
  fi

  INFO_EXISTS=true

  run_check_pve "info_status" "pct status $(shell_quote "$REQUEST_VMID") | awk '{print \$2}'"
  INFO_STATUS="$(safe_assoc_get CMD_STDOUT info_status "")"

  run_check_pve "info_config" "pct config $(shell_quote "$REQUEST_VMID")"
  INFO_CONFIG="$(safe_assoc_get CMD_OUTPUT info_config "")"

  run_check_pve "info_ip" "pct exec $(shell_quote "$REQUEST_VMID") -- bash -lc $(shell_quote "ip -4 -o addr show dev ${CT_NET_IFACE} | awk '{print \$4}' | head -n1 | cut -d/ -f1") || true"
  INFO_IP="$(safe_assoc_get CMD_STDOUT info_ip "")"

  run_check_pve "info_name" "pct config $(shell_quote "$REQUEST_VMID") | awk -F': ' '/^hostname:/ {print \$2; exit}'"
  INFO_NAME="$(safe_assoc_get CMD_STDOUT info_name "")"

  INFO_RC="0"
  INFO_OUTPUT="ok"
  INFO_OK=true
}

run_stop_ct_phase() {
  log INFO "Running stop-ct phase"
  collect_common_inventory

  if ! vmid_exists "$REQUEST_VMID"; then
    STOP_EXISTS=false
    STOP_OK=false
    add_stop_warning "CT/VMID not found."
    return 0
  fi

  if ! in_array_exact "$REQUEST_VMID" "${EXISTING_CT[@]}"; then
    STOP_EXISTS=false
    STOP_OK=false
    add_stop_warning "Requested VMID exists but is not a CT."
    return 0
  fi

  STOP_EXISTS=true

  run_check_pve "stop_prev_status" "pct status $(shell_quote "$REQUEST_VMID") | awk '{print \$2}'"
  STOP_PREV_STATUS="$(safe_assoc_get CMD_STDOUT stop_prev_status "")"

  if [ "$STOP_PREV_STATUS" = "stopped" ]; then
    STOP_FINAL_STATUS="stopped"
    STOP_RC="0"
    STOP_OUTPUT="already stopped"
    STOP_OK=true
    return 0
  fi

  run_check_pve "stop_ct" "pct stop $(shell_quote "$REQUEST_VMID")"
  STOP_RC="$(safe_assoc_get CMD_RC stop_ct 1)"
  STOP_OUTPUT="$(safe_assoc_get CMD_OUTPUT stop_ct "")"

  if [ "$STOP_RC" -ne 0 ]; then
    add_stop_warning "pct stop failed."
    STOP_OK=false
    return 0
  fi

  run_check_pve "stop_final_status" "pct status $(shell_quote "$REQUEST_VMID") | awk '{print \$2}'"
  STOP_FINAL_STATUS="$(safe_assoc_get CMD_STDOUT stop_final_status "")"

  if [ "$STOP_FINAL_STATUS" = "stopped" ]; then
    STOP_OK=true
  else
    add_stop_warning "CT did not reach stopped state."
    STOP_OK=false
  fi
}

run_destroy_ct_phase() {
  log INFO "Running destroy-ct phase"
  collect_common_inventory

  if ! vmid_exists "$REQUEST_VMID"; then
    DESTROY_EXISTS=false
    DESTROY_OK=false
    add_destroy_warning "CT/VMID not found."
    return 0
  fi

  if ! in_array_exact "$REQUEST_VMID" "${EXISTING_CT[@]}"; then
    DESTROY_EXISTS=false
    DESTROY_OK=false
    add_destroy_warning "Requested VMID exists but is not a CT."
    return 0
  fi

  DESTROY_EXISTS=true

  run_check_pve "destroy_prev_status" "pct status $(shell_quote "$REQUEST_VMID") | awk '{print \$2}'"
  local prev_status
  prev_status="$(safe_assoc_get CMD_STDOUT destroy_prev_status "")"

  if [ "$prev_status" = "running" ]; then
    run_check_pve "destroy_stop_ct" "pct stop $(shell_quote "$REQUEST_VMID")"
    if [ "$(safe_assoc_get CMD_RC destroy_stop_ct 1)" -ne 0 ]; then
      DESTROY_RC="$(safe_assoc_get CMD_RC destroy_stop_ct 1)"
      DESTROY_OUTPUT="$(safe_assoc_get CMD_OUTPUT destroy_stop_ct "")"
      add_destroy_warning "Failed to stop CT before destroy."
      DESTROY_OK=false
      return 0
    fi
    DESTROY_STOPPED=true
  fi

  run_check_pve "destroy_ct" "pct destroy $(shell_quote "$REQUEST_VMID")"
  DESTROY_RC="$(safe_assoc_get CMD_RC destroy_ct 1)"
  DESTROY_OUTPUT="$(safe_assoc_get CMD_OUTPUT destroy_ct "")"

  if [ "$DESTROY_RC" -eq 0 ]; then
    DESTROY_OK=true
  else
    add_destroy_warning "pct destroy failed."
    DESTROY_OK=false
  fi
}

run_ensure_ct_phase() {
  log INFO "Running ensure-ct phase"
  reset_create_state
  collect_common_inventory
  resolve_create_ct_defaults

  ENSURE_EXISTS=false
  ENSURE_CREATED=false
  ENSURE_STARTED=false
  ENSURE_IP=""
  ENSURE_STATUS=""
  ENSURE_POSTINSTALL_OK=false
  ENSURE_SSH_OK=false
  ENSURE_WARNINGS=()

  if vmid_exists "$REQUEST_VMID"; then
    if ! in_array_exact "$REQUEST_VMID" "${EXISTING_CT[@]}"; then
      add_ensure_warning "Requested VMID exists but is not a CT."
      ENSURE_OK=false
      return 0
    fi

    ENSURE_EXISTS=true

    run_check_pve "ensure_status" "pct status $(shell_quote "$REQUEST_VMID") | awk '{print \$2}'"
    ENSURE_STATUS="$(safe_assoc_get CMD_STDOUT ensure_status "")"

    if [ "$ENSURE_STATUS" != "running" ]; then
      run_check_pve "ensure_start" "pct start $(shell_quote "$REQUEST_VMID")"
      if [ "$(safe_assoc_get CMD_RC ensure_start 1)" -ne 0 ]; then
        add_ensure_warning "Failed to start existing CT."
        ENSURE_OK=false
        return 0
      fi
      ENSURE_STARTED=true
      run_check_pve "ensure_status_after" "pct status $(shell_quote "$REQUEST_VMID") | awk '{print \$2}'"
      ENSURE_STATUS="$(safe_assoc_get CMD_STDOUT ensure_status_after "")"
    fi

    if [ "$ENSURE_RECONFIGURE" -eq 1 ]; then
      log INFO "Running CT network post-install"
      run_ct_postinstall || true
      ENSURE_POSTINSTALL_OK="$CREATE_POSTINSTALL_OK"

      log INFO "Installing OpenSSH in CT"
      install_ct_ssh || true
      ENSURE_SSH_OK="$CREATE_SSH_OK"
    else
      ENSURE_POSTINSTALL_OK=false
      ENSURE_SSH_OK=false
    fi

    if wait_for_ct_ipv4 20; then
      ENSURE_IP="$CREATE_IP"
    else
      add_ensure_warning "CT IPv4 address was not detected in time."
    fi

    ENSURE_OK=true
    return 0
  fi

  run_create_ct_phase

  if [ "$CREATE_OK" = true ] && [ "$CREATE_CREATED" = true ] && [ "$CREATE_STARTED" = true ]; then
    ENSURE_EXISTS=true
    ENSURE_CREATED=true
    ENSURE_STARTED=true
    ENSURE_STATUS="$CREATE_STATUS"
    ENSURE_IP="$CREATE_IP"
    ENSURE_POSTINSTALL_OK="$CREATE_POSTINSTALL_OK"
    ENSURE_SSH_OK="$CREATE_SSH_OK"
    ENSURE_WARNINGS=("${CREATE_WARNINGS[@]}")
    ENSURE_OK=true
  else
    ENSURE_WARNINGS=("${CREATE_WARNINGS[@]}")
    ENSURE_OK=false
  fi
}

#------------------------------------------------------------------------------
# Analyse / compute ok / summary
#------------------------------------------------------------------------------
analyze_findings() {
  local proxmox_markers=0
  local combined=""

  combined="$(safe_assoc_get CMD_OUTPUT pveversion "")"$'\n'"$(safe_assoc_get CMD_OUTPUT pveam "")"$'\n'"$(safe_assoc_get CMD_OUTPUT pvesm "")"$'\n'"$(safe_assoc_get CMD_OUTPUT pct "")"$'\n'"$(safe_assoc_get CMD_OUTPUT qm "")"

  if [ "$(safe_assoc_get CMD_FOUND pveversion false)" = true ]; then proxmox_markers=$((proxmox_markers + 1)); fi
  if [ "$(safe_assoc_get CMD_FOUND pveam false)" = true ]; then proxmox_markers=$((proxmox_markers + 1)); fi
  if [ "$(safe_assoc_get CMD_FOUND pvesm false)" = true ]; then proxmox_markers=$((proxmox_markers + 1)); fi
  if [ "$(safe_assoc_get CMD_FOUND pct false)" = true ]; then proxmox_markers=$((proxmox_markers + 1)); fi
  if [ "$(safe_assoc_get CMD_FOUND qm false)" = true ]; then proxmox_markers=$((proxmox_markers + 1)); fi

  if [ "$proxmox_markers" -ge 2 ]; then
    HOST_IS_PROXMOX=true
  else
    HOST_IS_PROXMOX=false
    LIKELY_WRONG_HOST=true
  fi

  if contains_text "$combined" 'Unable to load access control list|access control list|permission denied|not enough permissions|authentication failed|connection from bad user|rejected'; then
    ACL_OR_PERMISSION_ISSUE=true
    REQUIRES_ROOT_FOR_PROXMOX_COMMANDS=true
    LIKELY_WRONG_USER_OR_CONTEXT=true
    add_recommendation "Some Proxmox commands were rejected by the Proxmox IPC or ACL layer."
  fi

  if [ "$USE_SUDO" -eq 1 ] && [ "$SUDO_OK" = false ]; then
    LIKELY_WRONG_USER_OR_CONTEXT=true
  fi

  if [ "$SSH_OK" = true ] && [ "$HOST_IS_PROXMOX" = true ] \
     && [ "$(safe_assoc_get CMD_RC pveversion 127)" -eq 0 ] \
     && [ "$(safe_assoc_get CMD_RC pveam 127)" -eq 0 ] \
     && [ "$(safe_assoc_get CMD_RC pvesm 127)" -eq 0 ] \
     && [ "$(safe_assoc_get CMD_RC pct 127)" -eq 0 ] \
     && [ "$(safe_assoc_get CMD_RC qm 127)" -eq 0 ]; then
    add_recommendation "SSH, sudo context, and core Proxmox diagnostics look healthy."
  fi

  case "$MODE" in
    collect)
      if [ -n "$NEXTID" ]; then add_recommendation "Collect phase returned a next available VMID."; else add_collect_warning "Collect phase did not return nextid."; fi
      if [ "${#STORAGES[@]}" -gt 0 ]; then add_recommendation "Collect phase returned at least one available storage."; fi
      ;;
    preflight-create)
      if [ "$PREFLIGHT_TYPE_VALID" = true ]; then add_recommendation "Preflight create type is valid."; fi
      if [ -n "$PREFLIGHT_VMID_SUGGESTED" ]; then add_recommendation "Preflight create suggested an available VMID."; fi
      if [ -n "$PREFLIGHT_STORAGE_DEFAULT" ]; then add_recommendation "Preflight create suggested a default storage."; fi
      if [ -n "$PREFLIGHT_BRIDGE_DEFAULT" ]; then add_recommendation "Preflight create suggested a default bridge."; fi
      ;;
    create-ct)
      if [ "$CREATE_CREATED" = true ]; then add_recommendation "CT was created successfully."; fi
      if [ "$CREATE_STARTED" = true ]; then add_recommendation "CT reached running state."; fi
      if [ -n "${CREATE_IP-}" ]; then add_recommendation "CT IPv4 address was detected."; fi
      ;;
    get-ct-info)
      if [ "$INFO_EXISTS" = true ]; then add_recommendation "CT information was collected."; fi
      ;;
    stop-ct)
      if [ "$STOP_OK" = true ]; then add_recommendation "CT stop completed successfully."; fi
      ;;
    destroy-ct)
      if [ "$DESTROY_OK" = true ]; then add_recommendation "CT destroy completed successfully."; fi
      ;;
    ensure-ct)
      if [ "$ENSURE_OK" = true ]; then add_recommendation "Ensure CT completed successfully."; fi
      ;;
  esac
}

base_checks_ok() {
  [ "$SSH_OK" = true ] || return 1
  [ "$HOST_IS_PROXMOX" = true ] || return 1
  if [ "$USE_SUDO" -eq 1 ]; then [ "$SUDO_OK" = true ] || return 1; fi
  [ "$(safe_assoc_get CMD_RC pveversion 127)" -eq 0 ] || return 1
  [ "$(safe_assoc_get CMD_RC pveam 127)" -eq 0 ] || return 1
  [ "$(safe_assoc_get CMD_RC pvesm 127)" -eq 0 ] || return 1
  [ "$(safe_assoc_get CMD_RC pct 127)" -eq 0 ] || return 1
  [ "$(safe_assoc_get CMD_RC qm 127)" -eq 0 ] || return 1
  return 0
}

preflight_create_ready() {
  base_checks_ok || return 1
  [ "$PREFLIGHT_TYPE_VALID" = true ] || return 1
  [ "$PREFLIGHT_VMID_AVAILABLE" = true ] || return 1
  if [ -n "${REQUEST_TEMPLATE-}" ]; then [ "$PREFLIGHT_TEMPLATE_EXISTS" = true ] || return 1; fi
  if [ -n "${REQUEST_STORAGE-}" ]; then [ "$PREFLIGHT_STORAGE_EXISTS" = true ] || return 1; fi
  if [ -n "${REQUEST_BRIDGE-}" ]; then [ "$PREFLIGHT_BRIDGE_EXISTS" = true ] || return 1; fi
  return 0
}

create_ct_success() { base_checks_ok && [ "$CREATE_CREATED" = true ] && [ "$CREATE_STARTED" = true ] && [ "$CREATE_OK" = true ]; }
get_ct_info_success() { base_checks_ok && [ "$INFO_OK" = true ]; }
stop_ct_success() { base_checks_ok && [ "$STOP_OK" = true ]; }
destroy_ct_success() { base_checks_ok && [ "$DESTROY_OK" = true ]; }
ensure_ct_success() { base_checks_ok && [ "$ENSURE_OK" = true ]; }
self_doc_success() { return 0; }

compute_ok() {
  case "$MODE" in
    self-doc) self_doc_success ;;
    diagnose|collect) base_checks_ok ;;
    preflight-create) preflight_create_ready ;;
    create-ct) create_ct_success ;;
    get-ct-info) get_ct_info_success ;;
    stop-ct) stop_ct_success ;;
    destroy-ct) destroy_ct_success ;;
    ensure-ct) ensure_ct_success ;;
    *) return 1 ;;
  esac
}

summary_text() {
  if [ "$MODE" = "self-doc" ]; then
    printf 'Script documentation returned successfully.'
    return
  fi

  if [ "$SSH_OK" != true ]; then
    printf 'SSH connectivity or non-interactive authentication failed.'
    return
  fi
  if [ "$USE_SUDO" -eq 1 ] && [ "$SUDO_OK" != true ]; then
    printf 'SSH works, but sudo -n is not usable for the allowed Proxmox commands.'
    return
  fi
  if [ "$HOST_IS_PROXMOX" != true ]; then
    printf 'SSH works, but the target does not look like a Proxmox VE node.'
    return
  fi

  case "$MODE" in
    preflight-create)
      if preflight_create_ready; then printf 'Preflight create checks look healthy.'; else printf 'Preflight create completed, but one or more requested checks failed.'; fi
      ;;
    create-ct)
      if create_ct_success; then
        if [ -n "${CREATE_IP-}" ]; then printf 'CT creation completed successfully and an IPv4 address was detected.'; else printf 'CT creation completed successfully, but no IPv4 address was detected yet.'; fi
      else
        printf 'CT creation started, but one or more steps failed.'
      fi
      ;;
    get-ct-info)
      if get_ct_info_success; then printf 'CT information was collected successfully.'; else printf 'CT information collection failed.'; fi
      ;;
    stop-ct)
      if stop_ct_success; then printf 'CT stop completed successfully.'; else printf 'CT stop failed.'; fi
      ;;
    destroy-ct)
      if destroy_ct_success; then printf 'CT destroy completed successfully.'; else printf 'CT destroy failed.'; fi
      ;;
    ensure-ct)
      if ensure_ct_success; then printf 'Ensure CT completed successfully.'; else printf 'Ensure CT failed.'; fi
      ;;
    *)
      if compute_ok; then
        if [ "$MODE" = "collect" ]; then
          if [ -n "$NEXTID" ]; then printf 'SSH, sudo context, diagnostics, and collect phase look healthy.'; else printf 'SSH and Proxmox collect mostly work, but nextid is missing.'; fi
        else
          printf 'SSH, sudo context, and core Proxmox diagnostics look healthy.'
        fi
      else
        printf 'SSH works and the target is Proxmox, but some checks still fail.'
      fi
      ;;
  esac
}

#------------------------------------------------------------------------------
# JSON final
#------------------------------------------------------------------------------
emit_json() {
  local ok_value summary
  summary="$(summary_text)"

  if compute_ok; then ok_value=true; else ok_value=false; fi

  {
    printf '{'
    printf '"ok":%s,' "$ok_value"
    printf '"mode":"%s",' "$(printf '%s' "${MODE-diagnose}" | json_escape)"

    printf '"target":{'
    printf '"host":"%s",' "$(printf '%s' "${HOST-}" | json_escape)"
    printf '"port":"%s",' "$(printf '%s' "${PORT-22}" | json_escape)"
    printf '"user":"%s"' "$(printf '%s' "${USER_NAME-}" | json_escape)"
    printf '},'

    printf '"execution":{'
    printf '"use_sudo":%s,' "$( [ "$USE_SUDO" -eq 1 ] && printf true || printf false )"
    printf '"sudo_ok":%s,' "$(json_bool "$SUDO_OK")"
    printf '"requires_root_for_proxmox_commands":%s' "$(json_bool "$REQUIRES_ROOT_FOR_PROXMOX_COMMANDS")"
    printf '},'

    printf '"ssh":{'
    printf '"rc":%s,' "${SSH_PROBE_RC-0}"
    printf '"stdout":"%s",' "$(printf '%s' "${SSH_PROBE_STDOUT-}" | json_escape)"
    printf '"stderr":"%s",' "$(printf '%s' "${SSH_PROBE_STDERR-}" | json_escape)"
    printf '"interactive_password_required":%s,' "$(json_bool "$SSH_INTERACTIVE_PASSWORD_REQUIRED")"
    printf '"host_key_issue":%s' "$(json_bool "$SSH_HOST_KEY_ISSUE")"
    printf '},'

    printf '"checks":{'
    printf '"ssh_ok":%s,' "$(json_bool "$SSH_OK")"
    printf '"host_is_proxmox":%s,' "$(json_bool "$HOST_IS_PROXMOX")"
    printf '"likely_wrong_host":%s,' "$(json_bool "$LIKELY_WRONG_HOST")"
    printf '"likely_wrong_user_or_context":%s,' "$(json_bool "$LIKELY_WRONG_USER_OR_CONTEXT")"
    printf '"acl_or_permission_issue":%s,' "$(json_bool "$ACL_OR_PERMISSION_ISSUE")"
    printf '"commands_missing":'
    json_array_strings "${COMMANDS_MISSING[@]}"
    printf '},'

    printf '"environment":{'
    printf '"hostname":"%s",' "$(printf '%s' "${REMOTE_HOSTNAME-}" | json_escape)"
    printf '"os":"%s",' "$(printf '%s' "${REMOTE_OS-}" | json_escape)"
    printf '"arch":"%s",' "$(printf '%s' "${REMOTE_ARCH-}" | json_escape)"
    printf '"path":"%s",' "$(printf '%s' "${REMOTE_PATH-}" | json_escape)"
    printf '"whoami":"%s",' "$(printf '%s' "${REMOTE_WHOAMI-}" | json_escape)"
    printf '"id":"%s"' "$(printf '%s' "${REMOTE_ID-}" | json_escape)"
    printf '},'

    printf '"commands":{'
    printf '"pveversion":{"found":%s,"rc":%s,"output":"%s"},' \
      "$(json_bool "$(safe_assoc_get CMD_FOUND pveversion false)")" \
      "$(safe_assoc_get CMD_RC pveversion 127)" \
      "$(printf '%s' "$(safe_assoc_get CMD_OUTPUT pveversion "command not found")" | json_escape_truncated)"

    printf '"pveam":{"found":%s,"rc":%s,"output":"%s"},' \
      "$(json_bool "$(safe_assoc_get CMD_FOUND pveam false)")" \
      "$(safe_assoc_get CMD_RC pveam 127)" \
      "$(printf '%s' "$(safe_assoc_get CMD_OUTPUT pveam "command not found")" | json_escape_truncated)"

    printf '"pvesm":{"found":%s,"rc":%s,"output":"%s"},' \
      "$(json_bool "$(safe_assoc_get CMD_FOUND pvesm false)")" \
      "$(safe_assoc_get CMD_RC pvesm 127)" \
      "$(printf '%s' "$(safe_assoc_get CMD_OUTPUT pvesm "command not found")" | json_escape_truncated)"

    printf '"pct":{"found":%s,"rc":%s,"output":"%s"},' \
      "$(json_bool "$(safe_assoc_get CMD_FOUND pct false)")" \
      "$(safe_assoc_get CMD_RC pct 127)" \
      "$(printf '%s' "$(safe_assoc_get CMD_OUTPUT pct "command not found")" | json_escape_truncated)"

    printf '"qm":{"found":%s,"rc":%s,"output":"%s"},' \
      "$(json_bool "$(safe_assoc_get CMD_FOUND qm false)")" \
      "$(safe_assoc_get CMD_RC qm 127)" \
      "$(printf '%s' "$(safe_assoc_get CMD_OUTPUT qm "command not found")" | json_escape_truncated)"

    printf '"sudo_probe":{"found":%s,"rc":%s,"output":"%s"}' \
      "$(json_bool "$(safe_assoc_get CMD_FOUND sudo false)")" \
      "$(safe_assoc_get CMD_RC sudo_probe 127)" \
      "$(printf '%s' "$(safe_assoc_get CMD_OUTPUT sudo_probe "")" | json_escape_truncated)"
    printf '},'

    if [ "$MODE" = "collect" ]; then
      printf '"collect":{'
      printf '"nextid":"%s",' "$(printf '%s' "${NEXTID-}" | json_escape)"
      printf '"templates":'; json_array_strings "${TEMPLATES[@]}"; printf ','
      printf '"local_templates":'; json_array_strings "${LOCAL_TEMPLATES[@]}"; printf ','
      printf '"storages":'; json_array_strings "${STORAGES[@]}"; printf ','
      printf '"bridges":'; json_array_strings "${BRIDGES[@]}"; printf ','
      printf '"existing_ct":'; json_array_strings "${EXISTING_CT[@]}"; printf ','
      printf '"existing_vm":'; json_array_strings "${EXISTING_VM[@]}"; printf ','
      printf '"warnings":'; json_array_strings "${COLLECT_WARNINGS[@]}"
      printf '},'
    fi

    if [ "$MODE" = "preflight-create" ]; then
      printf '"preflight":{'
      printf '"type_requested":"%s",' "$(printf '%s' "${REQUEST_TYPE-}" | json_escape)"
      printf '"type_valid":%s,' "$(json_bool "$PREFLIGHT_TYPE_VALID")"
      printf '"template_requested":"%s",' "$(printf '%s' "${REQUEST_TEMPLATE-}" | json_escape)"
      printf '"template_exists":%s,' "$(json_nullable_bool "$PREFLIGHT_TEMPLATE_EXISTS")"
      printf '"template_available_catalog":%s,' "$(json_nullable_bool "$PREFLIGHT_TEMPLATE_AVAILABLE_CATALOG")"
      printf '"template_available_local":%s,' "$(json_nullable_bool "$PREFLIGHT_TEMPLATE_AVAILABLE_LOCAL")"
      printf '"storage_requested":"%s",' "$(printf '%s' "${REQUEST_STORAGE-}" | json_escape)"
      printf '"storage_exists":%s,' "$(json_nullable_bool "$PREFLIGHT_STORAGE_EXISTS")"
      printf '"storage_default":"%s",' "$(printf '%s' "${PREFLIGHT_STORAGE_DEFAULT-}" | json_escape)"
      printf '"bridge_requested":"%s",' "$(printf '%s' "${REQUEST_BRIDGE-}" | json_escape)"
      printf '"bridge_exists":%s,' "$(json_nullable_bool "$PREFLIGHT_BRIDGE_EXISTS")"
      printf '"bridge_default":"%s",' "$(printf '%s' "${PREFLIGHT_BRIDGE_DEFAULT-}" | json_escape)"
      printf '"vmid_requested":"%s",' "$(printf '%s' "${REQUEST_VMID-}" | json_escape)"
      printf '"vmid_suggested":"%s",' "$(printf '%s' "${PREFLIGHT_VMID_SUGGESTED-}" | json_escape)"
      printf '"vmid_available":%s,' "$(json_bool "$PREFLIGHT_VMID_AVAILABLE")"
      printf '"hostname_requested":"%s",' "$(printf '%s' "${REQUEST_HOSTNAME-}" | json_escape)"
      printf '"warnings":'; json_array_strings "${PREFLIGHT_WARNINGS[@]}"
      printf '},'
      printf '"plan":{"create_ready":%s},' "$( preflight_create_ready && printf true || printf false )"
    fi

    if [ "$MODE" = "create-ct" ]; then
      printf '"result":{'
      printf '"created":%s,' "$(json_bool "$CREATE_CREATED")"
      printf '"started":%s,' "$(json_bool "$CREATE_STARTED")"
      printf '"template_downloaded":%s,' "$(json_bool "$CREATE_TEMPLATE_DOWNLOADED")"
      printf '"postinstall_ok":%s,' "$(json_bool "$CREATE_POSTINSTALL_OK")"
      printf '"ssh_installed_ok":%s,' "$(json_bool "$CREATE_SSH_OK")"
      printf '"vmid":"%s",' "$(printf '%s' "${REQUEST_VMID-}" | json_escape)"
      printf '"hostname":"%s",' "$(printf '%s' "${REQUEST_HOSTNAME-}" | json_escape)"
      printf '"template":"%s",' "$(printf '%s' "${REQUEST_TEMPLATE-}" | json_escape)"
      printf '"template_source":"%s",' "$(printf '%s' "${CREATE_TEMPLATE_SOURCE-}" | json_escape)"
      printf '"template_volume":"%s",' "$(printf '%s' "${CREATE_TEMPLATE_VOLUME-}" | json_escape)"
      printf '"rootfs_spec":"%s",' "$(printf '%s' "${CREATE_ROOTFS_SPEC-}" | json_escape)"
      printf '"storage":"%s",' "$(printf '%s' "${REQUEST_STORAGE-}" | json_escape)"
      printf '"bridge":"%s",' "$(printf '%s' "${REQUEST_BRIDGE-}" | json_escape)"
      printf '"status":"%s",' "$(printf '%s' "${CREATE_STATUS-}" | json_escape)"
      printf '"ip":"%s",' "$(printf '%s' "${CREATE_IP-}" | json_escape)"
      printf '"ssh_port":"22",'
      printf '"create_ct_rc":"%s",' "$(printf '%s' "${CREATE_CT_RC-}" | json_escape)"
      printf '"create_ct_output":"%s",' "$(printf '%s' "${CREATE_CT_OUTPUT-}" | json_escape_truncated)"
      printf '"start_ct_rc":"%s",' "$(printf '%s' "${START_CT_RC-}" | json_escape)"
      printf '"start_ct_output":"%s",' "$(printf '%s' "${START_CT_OUTPUT-}" | json_escape_truncated)"
      printf '"postinstall_rc":"%s",' "$(printf '%s' "${POSTINSTALL_RC-}" | json_escape)"
      printf '"postinstall_output":"%s",' "$(printf '%s' "${POSTINSTALL_OUTPUT-}" | json_escape_truncated)"
      printf '"install_ssh_rc":"%s",' "$(printf '%s' "${INSTALL_SSH_RC-}" | json_escape)"
      printf '"install_ssh_output":"%s",' "$(printf '%s' "${INSTALL_SSH_OUTPUT-}" | json_escape_truncated)"
      printf '"warnings":'; json_array_strings "${CREATE_WARNINGS[@]}"
      printf '},'
    fi

    if [ "$MODE" = "get-ct-info" ]; then
      printf '"result":{'
      printf '"exists":%s,' "$(json_bool "$INFO_EXISTS")"
      printf '"vmid":"%s",' "$(printf '%s' "${REQUEST_VMID-}" | json_escape)"
      printf '"status":"%s",' "$(printf '%s' "${INFO_STATUS-}" | json_escape)"
      printf '"name":"%s",' "$(printf '%s' "${INFO_NAME-}" | json_escape)"
      printf '"ip":"%s",' "$(printf '%s' "${INFO_IP-}" | json_escape)"
      printf '"config":"%s",' "$(printf '%s' "${INFO_CONFIG-}" | json_escape_truncated)"
      printf '"rc":"%s",' "$(printf '%s' "${INFO_RC-}" | json_escape)"
      printf '"output":"%s",' "$(printf '%s' "${INFO_OUTPUT-}" | json_escape_truncated)"
      printf '"warnings":'; json_array_strings "${INFO_WARNINGS[@]}"
      printf '},'
    fi

    if [ "$MODE" = "stop-ct" ]; then
      printf '"result":{'
      printf '"exists":%s,' "$(json_bool "$STOP_EXISTS")"
      printf '"vmid":"%s",' "$(printf '%s' "${REQUEST_VMID-}" | json_escape)"
      printf '"previous_status":"%s",' "$(printf '%s' "${STOP_PREV_STATUS-}" | json_escape)"
      printf '"final_status":"%s",' "$(printf '%s' "${STOP_FINAL_STATUS-}" | json_escape)"
      printf '"rc":"%s",' "$(printf '%s' "${STOP_RC-}" | json_escape)"
      printf '"output":"%s",' "$(printf '%s' "${STOP_OUTPUT-}" | json_escape_truncated)"
      printf '"warnings":'; json_array_strings "${STOP_WARNINGS[@]}"
      printf '},'
    fi

    if [ "$MODE" = "destroy-ct" ]; then
      printf '"result":{'
      printf '"exists":%s,' "$(json_bool "$DESTROY_EXISTS")"
      printf '"stopped_before_destroy":%s,' "$(json_bool "$DESTROY_STOPPED")"
      printf '"vmid":"%s",' "$(printf '%s' "${REQUEST_VMID-}" | json_escape)"
      printf '"rc":"%s",' "$(printf '%s' "${DESTROY_RC-}" | json_escape)"
      printf '"output":"%s",' "$(printf '%s' "${DESTROY_OUTPUT-}" | json_escape_truncated)"
      printf '"warnings":'; json_array_strings "${DESTROY_WARNINGS[@]}"
      printf '},'
    fi

    if [ "$MODE" = "ensure-ct" ]; then
      printf '"result":{'
      printf '"exists":%s,' "$(json_bool "$ENSURE_EXISTS")"
      printf '"created":%s,' "$(json_bool "$ENSURE_CREATED")"
      printf '"started":%s,' "$(json_bool "$ENSURE_STARTED")"
      printf '"reconfigure":%s,' "$( [ "$ENSURE_RECONFIGURE" -eq 1 ] && printf true || printf false )"
      printf '"postinstall_ok":%s,' "$(json_bool "$ENSURE_POSTINSTALL_OK")"
      printf '"ssh_installed_ok":%s,' "$(json_bool "$ENSURE_SSH_OK")"
      printf '"vmid":"%s",' "$(printf '%s' "${REQUEST_VMID-}" | json_escape)"
      printf '"hostname":"%s",' "$(printf '%s' "${REQUEST_HOSTNAME-}" | json_escape)"
      printf '"template":"%s",' "$(printf '%s' "${REQUEST_TEMPLATE-}" | json_escape)"
      printf '"storage":"%s",' "$(printf '%s' "${REQUEST_STORAGE-}" | json_escape)"
      printf '"bridge":"%s",' "$(printf '%s' "${REQUEST_BRIDGE-}" | json_escape)"
      printf '"status":"%s",' "$(printf '%s' "${ENSURE_STATUS-}" | json_escape)"
      printf '"ip":"%s",' "$(printf '%s' "${ENSURE_IP-}" | json_escape)"
      printf '"ssh_port":"22",'
      printf '"warnings":'; json_array_strings "${ENSURE_WARNINGS[@]}"
      printf '},'
    fi

    emit_docs_json
    printf ','

    printf '"recommendations":'; json_array_strings "${RECOMMENDATIONS[@]}"; printf ','
    printf '"summary":"%s"' "$(printf '%s' "$summary" | json_escape)"
    printf '}'
    printf '\n'
  } | {
    if [ "${OUTPUT-json}" = "pretty" ] && command -v python3 >/dev/null 2>&1; then
      python3 -m json.tool || cat
    else
      cat
    fi
  }
}

#------------------------------------------------------------------------------
# Main
#------------------------------------------------------------------------------
main() {
  parse_args "$@"
  enable_shell_trace

  if [ "$MODE" = "self-doc" ]; then
    log INFO "V ${SCRIPT_VERSION}"
    log INFO "Mode: self-doc"
    emit_json
    exit 0
  fi

  require_local_tools

  log INFO "V ${SCRIPT_VERSION}"
  log INFO "Mode: ${MODE-diagnose}"
  log INFO "Target: ${USER_NAME}@${HOST}:${PORT}"

  if [ -n "${IDENTITY_FILE-}" ] && [ ! -r "${IDENTITY_FILE-}" ]; then
    add_recommendation "Specified identity file is not readable by the local user."
  fi

  if ! probe_ssh; then
    emit_json
    exit 2
  fi

  collect_environment
  check_commands

  if [ "$USE_SUDO" -eq 1 ]; then
    check_sudo_for_pve || true
  fi

  run_proxmox_commands

  case "$MODE" in
    collect) run_collect_phase ;;
    preflight-create) run_preflight_create_phase ;;
    create-ct) reset_create_state; run_create_ct_phase ;;
    get-ct-info) run_get_ct_info_phase ;;
    stop-ct) run_stop_ct_phase ;;
    destroy-ct) run_destroy_ct_phase ;;
    ensure-ct) run_ensure_ct_phase ;;
    diagnose) collect_common_inventory ;;
  esac

  analyze_findings
  emit_json

  if compute_ok; then
    exit 0
  else
    exit 4
  fi
}

main "$@"
