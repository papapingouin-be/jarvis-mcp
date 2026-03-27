#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_BASENAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PHASE=""
CONFIRMED="false"
declare -A PARAMS=()

TMP_DIR=""

cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}

trap cleanup EXIT

log() {
  printf '[%s] %s\n' "$SCRIPT_BASENAME" "$*" >&2
}

json_escape() {
  local value="${1:-}"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

emit_json_error() {
  local summary="$1"
  local details="${2:-Operation failed}"
  local mode="${3:-unknown}"
  printf '{"ok":false,"mode":"%s","summary":"%s","details":"%s"}\n' \
    "$(json_escape "$mode")" \
    "$(json_escape "$summary")" \
    "$(json_escape "$details")"
  exit 1
}

on_unhandled_error() {
  local exit_code="$?"
  local line_no="${1:-unknown}"
  emit_json_error "Unhandled error" "Unexpected failure near line ${line_no} (exit ${exit_code})" "${PARAMS[mode]:-unknown}"
}

trap 'on_unhandled_error "$LINENO"' ERR

make_tmp_dir() {
  if [[ -z "${TMP_DIR}" ]]; then
    TMP_DIR="$(mktemp -d)"
  fi
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    emit_json_error "Missing dependency" "Required command not found: ${command_name}" "${PARAMS[mode]:-unknown}"
  fi
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
          emit_json_error "Invalid parameter" "Expected --param key=value" "argument-parse"
        fi
        PARAMS["$key"]="$value"
        shift 2
        ;;
      *)
        emit_json_error "Invalid argument" "Unknown argument: $1" "argument-parse"
        ;;
    esac
  done

  if [[ "$PHASE" != "collect" && "$PHASE" != "execute" ]]; then
    emit_json_error "Invalid phase" "Expected --phase collect or --phase execute" "argument-parse"
  fi

  case "${CONFIRMED}" in
    true|false)
      ;;
    *)
      emit_json_error "Invalid confirmation flag" "Expected --confirmed true or false" "argument-parse"
      ;;
  esac
}

param_or_default() {
  local key="$1"
  local fallback="${2:-}"
  if [[ -n "${PARAMS[$key]:-}" ]]; then
    printf '%s' "${PARAMS[$key]}"
    return
  fi
  printf '%s' "$fallback"
}

param_or_env() {
  local key="$1"
  local env_name="$2"
  local fallback="${3:-}"
  if [[ -n "${PARAMS[$key]:-}" ]]; then
    printf '%s' "${PARAMS[$key]}"
    return
  fi
  if [[ -n "${!env_name:-}" ]]; then
    printf '%s' "${!env_name}"
    return
  fi
  printf '%s' "$fallback"
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
      emit_json_error "Invalid boolean value" "Unsupported boolean value: ${value}" "${PARAMS[mode]:-unknown}"
      ;;
  esac
}

ensure_phase_for_mode() {
  local mode="$1"
  local expected_phase="$2"
  if [[ "$PHASE" != "$expected_phase" ]]; then
    emit_json_error "Invalid phase for mode" "Mode ${mode} requires phase=${expected_phase}" "$mode"
  fi
}

sql_escape() {
  local value="${1:-}"
  value=${value//\'/\'\'}
  printf '%s' "$value"
}

build_history_insert_sql() {
  local script_name="$1"
  local change_type="$2"
  local version="$3"
  local file_name="$4"
  local description="$5"
  local required_env_json="$6"
  local metadata_json="$7"
  local is_active="$8"

  cat <<EOF
INSERT INTO jarvis_script_registry_history (
  script_name,
  change_type,
  version,
  file_name,
  description,
  required_env_json,
  metadata_json,
  is_active,
  changed_at
) VALUES (
  '$(sql_escape "$script_name")',
  '$(sql_escape "$change_type")',
  $(if [[ -n "$version" ]]; then printf "'%s'" "$(sql_escape "$version")"; else printf 'NULL'; fi),
  '$(sql_escape "$file_name")',
  '$(sql_escape "$description")',
  '$(sql_escape "$required_env_json")'::jsonb,
  '$(sql_escape "$metadata_json")'::jsonb,
  ${is_active},
  NOW()
);
EOF
}

require_db_prerequisites() {
  require_command psql
}

build_psql_command() {
  local db_url
  local db_host
  local db_port
  local db_name
  local db_user
  local db_password

  db_url="$(param_or_env db_url JARVIS_DB_URL)"
  db_host="$(param_or_env db_host JARVIS_DB_HOST)"
  db_port="$(param_or_env db_port JARVIS_DB_PORT 5432)"
  db_name="$(param_or_env db_name JARVIS_DB_NAME)"
  db_user="$(param_or_env db_user JARVIS_DB_USER)"
  db_password="$(param_or_env db_password JARVIS_DB_PASSWORD)"

  PSQL_CMD=(psql -X -v ON_ERROR_STOP=1 -qtAX)
  PSQL_ENV_PREFIX=()

  if [[ -n "$db_password" ]]; then
    PSQL_ENV_PREFIX=(env "PGPASSWORD=${db_password}")
  fi

  if [[ -n "$db_url" ]]; then
    PSQL_CMD+=("$db_url")
    return
  fi

  if [[ -z "$db_host" || -z "$db_name" || -z "$db_user" ]]; then
    emit_json_error "Database connection is incomplete" "Provide db_url or db_host, db_name, and db_user" "${PARAMS[mode]:-unknown}"
  fi

  PSQL_CMD+=(-h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name")
}

run_psql_query() {
  local sql="$1"
  build_psql_command
  "${PSQL_ENV_PREFIX[@]}" "${PSQL_CMD[@]}" -c "$sql"
}

assert_registry_table_exists() {
  local exists
  exists="$(run_psql_query "SELECT to_regclass('public.jarvis_script_registry');" | tr -d '[:space:]')"
  if [[ "$exists" != "jarvis_script_registry" ]]; then
    emit_json_error "Missing table" "Table public.jarvis_script_registry does not exist" "${PARAMS[mode]:-unknown}"
  fi
}

ensure_registry_schema() {
  assert_registry_table_exists
  run_psql_query "
    ALTER TABLE jarvis_script_registry ADD COLUMN IF NOT EXISTS version VARCHAR(64) NULL;
    ALTER TABLE jarvis_script_registry ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS jarvis_script_registry_history (
      id BIGSERIAL PRIMARY KEY,
      script_name VARCHAR(128) NOT NULL,
      change_type VARCHAR(32) NOT NULL,
      version VARCHAR(64) NULL,
      file_name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      required_env_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_jarvis_script_registry_history_script
    ON jarvis_script_registry_history(script_name, changed_at DESC);
  " >/dev/null
}

get_scripts_root() {
  param_or_default scripts_root "$SCRIPT_DIR"
}

is_registry_candidate() {
  local path="$1"
  if [[ -x "$path" || "$path" == *.sh ]]; then
    return 0
  fi
  return 1
}

list_candidate_script_paths() {
  local scripts_root="$1"
  find "$scripts_root" -maxdepth 1 -type f -print0 \
    | while IFS= read -r -d '' path; do
        if is_registry_candidate "$path"; then
          printf '%s\n' "$path"
        fi
      done \
    | LC_ALL=C sort
}

registry_doc_jq_filter() {
  cat <<'EOF'
.ok == true
and .mode == "registry-doc"
and (.script | type == "object")
and (.script.script_name | type == "string" and length > 0)
and (.script.file_name | type == "string" and length > 0)
and ((.script.description // "") | type == "string")
and ((.script.version // "") | type == "string")
and (.script.required_env | type == "array")
and (.script.supports_registry == true)
and (.script.services | type == "array")
and (all(.script.required_env[]?;
  if type == "string" then
    length > 0
  elif type == "object" then
    (.name | type == "string" and length > 0)
    and (((.required // true) | type) == "boolean")
    and (((.secret // false) | type) == "boolean")
    and (((.description // "") | type) == "string")
  else
    false
  end
))
and (all(.script.services[]?;
  (.name | type == "string" and length > 0)
  and (.phase == "collect" or .phase == "execute")
  and (.confirmed_required | type == "boolean")
  and (.description | type == "string")
))
and (all(.script.tags[]?; type == "string"))
and (all(.script.capabilities[]?; type == "string"))
EOF
}

run_registry_doc() {
  local script_path="$1"
  local stdout_file="$2"
  local stderr_file="$3"

  if ! bash "$script_path" --phase collect --confirmed false --param mode=registry-doc >"$stdout_file" 2>"$stderr_file"; then
    return 1
  fi
  return 0
}

scan_one_script() {
  local script_path="$1"
  local script_file
  local stdout_file
  local stderr_file
  local metadata_file
  local error_message="null"

  make_tmp_dir
  script_file="$(basename "$script_path")"
  stdout_file="${TMP_DIR}/${script_file}.stdout.json"
  stderr_file="${TMP_DIR}/${script_file}.stderr.log"
  metadata_file="${TMP_DIR}/${script_file}.metadata.json"

  log "Scanning ${script_file}"

  if ! run_registry_doc "$script_path" "$stdout_file" "$stderr_file"; then
    error_message="$(jq -Rn --arg error "registry-doc execution failed" '$error')"
    jq -n \
      --arg file_name "$script_file" \
      --arg path "$script_path" \
      --argjson error "$error_message" \
      '{
        file_name: $file_name,
        path: $path,
        detected: true,
        registry_compatible: false,
        metadata: null,
        error: $error
      }'
    return
  fi

  if ! jq -e . "$stdout_file" >/dev/null 2>&1; then
    error_message="$(jq -Rn --arg error "registry-doc returned invalid JSON" '$error')"
    jq -n \
      --arg file_name "$script_file" \
      --arg path "$script_path" \
      --argjson error "$error_message" \
      '{
        file_name: $file_name,
        path: $path,
        detected: true,
        registry_compatible: false,
        metadata: null,
        error: $error
      }'
    return
  fi

  if ! jq -e "$(registry_doc_jq_filter)" "$stdout_file" >/dev/null 2>&1; then
    error_message="$(jq -Rn --arg error "registry-doc JSON does not match the required contract" '$error')"
    jq -n \
      --arg file_name "$script_file" \
      --arg path "$script_path" \
      --argjson error "$error_message" \
      '{
        file_name: $file_name,
        path: $path,
        detected: true,
        registry_compatible: false,
        metadata: null,
        error: $error
      }'
    return
  fi

  jq '.script' "$stdout_file" >"$metadata_file"

  if [[ "$(jq -r '.file_name' "$metadata_file")" != "$script_file" ]]; then
    error_message="$(jq -Rn --arg error "registry-doc file_name does not match the detected file name" '$error')"
    jq -n \
      --arg file_name "$script_file" \
      --arg path "$script_path" \
      --argjson error "$error_message" \
      '{
        file_name: $file_name,
        path: $path,
        detected: true,
        registry_compatible: false,
        metadata: null,
        error: $error
      }'
    return
  fi

  jq -n \
    --arg file_name "$script_file" \
    --arg path "$script_path" \
    --slurpfile metadata "$metadata_file" \
    '{
      file_name: $file_name,
      path: $path,
      detected: true,
      registry_compatible: true,
      metadata: $metadata[0],
      error: null
    }'
}

scan_scripts_to_file() {
  local scripts_root="$1"
  local ndjson_file="$2"
  : >"$ndjson_file"

  while IFS= read -r script_path; do
    scan_one_script "$script_path" >>"$ndjson_file"
  done < <(list_candidate_script_paths "$scripts_root")
}

build_scan_response() {
  local scripts_root="$1"
  local scripts_array_file="$2"
  jq -n \
    --arg mode "scan-scripts" \
    --arg scripts_root "$scripts_root" \
    --slurpfile scripts "$scripts_array_file" \
    '{
      ok: true,
      mode: $mode,
      scripts_root: $scripts_root,
      scripts: $scripts[0],
      summary: (
        (($scripts[0] | length) | tostring)
        + " script(s) scanned, "
        + (($scripts[0] | map(select(.registry_compatible == true)) | length) | tostring)
        + " compatible, "
        + (($scripts[0] | map(select(.registry_compatible == false)) | length) | tostring)
        + " incompatible"
      )
    }'
}

scan_scripts_mode() {
  ensure_phase_for_mode "scan-scripts" "collect"
  require_command jq
  make_tmp_dir

  local scripts_root
  local ndjson_file
  local array_file

  scripts_root="$(get_scripts_root)"
  [[ -d "$scripts_root" ]] || emit_json_error "Scripts directory not found" "Directory does not exist: ${scripts_root}" "scan-scripts"
  ndjson_file="${TMP_DIR}/scan.ndjson"
  array_file="${TMP_DIR}/scan.json"

  scan_scripts_to_file "$scripts_root" "$ndjson_file"
  jq -s '.' "$ndjson_file" >"$array_file"
  build_scan_response "$scripts_root" "$array_file"
}

describe_script_mode() {
  ensure_phase_for_mode "describe-script" "collect"
  require_command jq
  make_tmp_dir

  local scripts_root
  local target_name
  local ndjson_file
  local array_file

  scripts_root="$(get_scripts_root)"
  [[ -d "$scripts_root" ]] || emit_json_error "Scripts directory not found" "Directory does not exist: ${scripts_root}" "describe-script"
  target_name="$(param_or_default script_name)"
  if [[ -z "$target_name" ]]; then
    emit_json_error "Missing parameter" "describe-script requires --param script_name=..." "describe-script"
  fi

  ndjson_file="${TMP_DIR}/describe.ndjson"
  array_file="${TMP_DIR}/describe.json"

  scan_scripts_to_file "$scripts_root" "$ndjson_file"
  jq -s '.' "$ndjson_file" >"$array_file"

  if ! jq -e --arg target "$target_name" '
    any(.[]; .file_name == $target or (.metadata != null and .metadata.script_name == $target))
  ' "$array_file" >/dev/null 2>&1; then
    emit_json_error "Script not found" "No discovered script matches ${target_name}" "describe-script"
  fi

  jq -n \
    --arg mode "describe-script" \
    --arg scripts_root "$scripts_root" \
    --arg script_name "$target_name" \
    --slurpfile scripts "$array_file" \
    '{
      ok: true,
      mode: $mode,
      scripts_root: $scripts_root,
      script_name: $script_name,
      script: (
        $scripts[0]
        | map(select(.file_name == $script_name or (.metadata != null and .metadata.script_name == $script_name)))
        | .[0]
      ),
      summary: "Script description generated"
    }'
}

fetch_db_registry_to_file() {
  local output_file="$1"
  ensure_registry_schema
  run_psql_query "
    SELECT jsonb_build_object(
      'script_name', script_name,
      'file_name', file_name,
      'version', COALESCE(version, ''),
      'description', COALESCE(description, ''),
      'required_env_json', required_env_json,
      'metadata_json', COALESCE(metadata_json, '{}'::jsonb),
      'is_active', is_active,
      'history_count', COALESCE((SELECT COUNT(*) FROM jarvis_script_registry_history h WHERE h.script_name = jarvis_script_registry.script_name), 0),
      'updated_at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
    )::text
    FROM jarvis_script_registry
    ORDER BY script_name;
  " >"$output_file"
}

build_diff_payload_file() {
  local scan_array_file="$1"
  local db_array_file="$2"
  local diff_file="$3"

  jq -n \
    --slurpfile scan "$scan_array_file" \
    --slurpfile db "$db_array_file" \
    '
    def normalize_disk:
      ($scan[0]
        | map(select(.registry_compatible == true))
        | map({
            script_name: .metadata.script_name,
            file_name: .metadata.file_name,
            version: (.metadata.version // ""),
            description: (.metadata.description // ""),
            required_env_json: (.metadata.required_env // []),
            metadata_json: .metadata,
            services: (.metadata.services // []),
            tags: (.metadata.tags // []),
            capabilities: (.metadata.capabilities // []),
            path: .path,
            registry_compatible: true
          }));
    def normalize_db:
      ($db[0] // []);
    def disk_by_name:
      reduce normalize_disk[] as $item ({}; .[$item.script_name] = $item);
    def db_by_name:
      reduce normalize_db[] as $item ({}; .[$item.script_name] = $item);
    def all_names:
      ((normalize_disk | map(.script_name)) + (normalize_db | map(.script_name)) | unique | sort);
    def changed_entry($disk; $row):
      {
        script_name: $disk.script_name,
        disk: $disk,
        db: $row,
        differences: (
          [
            if $disk.file_name != $row.file_name then "file_name" else empty end,
            if ($disk.version // "") != ($row.version // "") then "version" else empty end,
            if ($disk.description // "") != ($row.description // "") then "description" else empty end,
            if (($disk.required_env_json // []) | tojson) != (($row.required_env_json // []) | tojson) then "required_env_json" else empty end,
            if (($disk.metadata_json // {}) | tojson) != (($row.metadata_json // {}) | tojson) then "metadata_json" else empty end,
            if (($row.is_active // true) != true) then "is_active" else empty end
          ]
        )
      };
    {
      missing_in_db: (
        all_names
        | map(select((disk_by_name[.] != null) and (db_by_name[.] == null)))
        | map(disk_by_name[.])
      ),
      missing_on_disk: (
        all_names
        | map(select((db_by_name[.] != null) and (disk_by_name[.] == null)))
        | map(db_by_name[.])
      ),
      changed: (
        all_names
        | map(select((db_by_name[.] != null) and (disk_by_name[.] != null)))
        | map(select(
            (disk_by_name[.].file_name != db_by_name[.].file_name)
            or ((disk_by_name[.].version // "") != (db_by_name[.].version // ""))
            or ((disk_by_name[.].description // "") != (db_by_name[.].description // ""))
            or (((disk_by_name[.].required_env_json // []) | tojson) != ((db_by_name[.].required_env_json // []) | tojson))
            or (((disk_by_name[.].metadata_json // {}) | tojson) != ((db_by_name[.].metadata_json // {}) | tojson))
            or ((db_by_name[.].is_active // true) != true)
          ))
        | map(changed_entry(disk_by_name[.]; db_by_name[.]))
      ),
      unchanged: (
        all_names
        | map(select((db_by_name[.] != null) and (disk_by_name[.] != null)))
        | map(select(
            (disk_by_name[.].file_name == db_by_name[.].file_name)
            and ((disk_by_name[.].version // "") == (db_by_name[.].version // ""))
            and ((disk_by_name[.].description // "") == (db_by_name[.].description // ""))
            and (((disk_by_name[.].required_env_json // []) | tojson) == ((db_by_name[.].required_env_json // []) | tojson))
            and (((disk_by_name[.].metadata_json // {}) | tojson) == ((db_by_name[.].metadata_json // {}) | tojson))
            and ((db_by_name[.].is_active // true) == true)
          ))
        | map({
            script_name: .,
            disk: disk_by_name[.],
            db: db_by_name[.]
          })
      )
    }
    ' >"$diff_file"
}

diff_registry_mode() {
  ensure_phase_for_mode "diff-registry" "collect"
  require_command jq
  require_db_prerequisites
  make_tmp_dir

  local scripts_root
  local scan_ndjson_file
  local scan_array_file
  local db_ndjson_file
  local db_array_file
  local diff_file

  scripts_root="$(get_scripts_root)"
  [[ -d "$scripts_root" ]] || emit_json_error "Scripts directory not found" "Directory does not exist: ${scripts_root}" "diff-registry"
  scan_ndjson_file="${TMP_DIR}/diff-scan.ndjson"
  scan_array_file="${TMP_DIR}/diff-scan.json"
  db_ndjson_file="${TMP_DIR}/diff-db.ndjson"
  db_array_file="${TMP_DIR}/diff-db.json"
  diff_file="${TMP_DIR}/diff.json"

  scan_scripts_to_file "$scripts_root" "$scan_ndjson_file"
  jq -s '.' "$scan_ndjson_file" >"$scan_array_file"

  fetch_db_registry_to_file "$db_ndjson_file"
  jq -s '.' "$db_ndjson_file" >"$db_array_file"

  build_diff_payload_file "$scan_array_file" "$db_array_file" "$diff_file"

  jq -n \
    --arg mode "diff-registry" \
    --arg scripts_root "$scripts_root" \
    --slurpfile diff "$diff_file" \
    '{
      ok: true,
      mode: $mode,
      scripts_root: $scripts_root,
      db: {
        connected: true
      },
      diff: $diff[0],
      summary: (
        (($diff[0].missing_in_db | length) | tostring) + " missing_in_db, "
        + (($diff[0].missing_on_disk | length) | tostring) + " missing_on_disk, "
        + (($diff[0].changed | length) | tostring) + " changed, "
        + (($diff[0].unchanged | length) | tostring) + " unchanged"
      )
    }'
}

sync_registry_mode() {
  ensure_phase_for_mode "sync-registry" "execute"
  require_command jq
  require_db_prerequisites
  make_tmp_dir

  local scripts_root
  local disable_missing
  local dry_run
  local scan_ndjson_file
  local scan_array_file
  local db_ndjson_file
  local db_array_file
  local diff_file
  local compatible_ndjson_file
  local inserted_ndjson_file
  local updated_ndjson_file
  local disabled_ndjson_file
  local unchanged_ndjson_file
  local skipped_ndjson_file
  local errors_ndjson_file

  scripts_root="$(get_scripts_root)"
  [[ -d "$scripts_root" ]] || emit_json_error "Scripts directory not found" "Directory does not exist: ${scripts_root}" "sync-registry"
  disable_missing="$(normalize_bool "$(param_or_default disable_missing false)")"
  dry_run="$(normalize_bool "$(param_or_default dry_run false)")"

  if [[ "$dry_run" != "true" && "$CONFIRMED" != "true" ]]; then
    emit_json_error "Confirmation required" "sync-registry with database writes requires --confirmed true" "sync-registry"
  fi

  scan_ndjson_file="${TMP_DIR}/sync-scan.ndjson"
  scan_array_file="${TMP_DIR}/sync-scan.json"
  db_ndjson_file="${TMP_DIR}/sync-db.ndjson"
  db_array_file="${TMP_DIR}/sync-db.json"
  diff_file="${TMP_DIR}/sync-diff.json"
  compatible_ndjson_file="${TMP_DIR}/compatible.ndjson"
  inserted_ndjson_file="${TMP_DIR}/inserted.ndjson"
  updated_ndjson_file="${TMP_DIR}/updated.ndjson"
  disabled_ndjson_file="${TMP_DIR}/disabled.ndjson"
  unchanged_ndjson_file="${TMP_DIR}/unchanged.ndjson"
  skipped_ndjson_file="${TMP_DIR}/skipped.ndjson"
  errors_ndjson_file="${TMP_DIR}/errors.ndjson"

  : >"$inserted_ndjson_file"
  : >"$updated_ndjson_file"
  : >"$disabled_ndjson_file"
  : >"$unchanged_ndjson_file"
  : >"$skipped_ndjson_file"
  : >"$errors_ndjson_file"

  scan_scripts_to_file "$scripts_root" "$scan_ndjson_file"
  jq -s '.' "$scan_ndjson_file" >"$scan_array_file"
  fetch_db_registry_to_file "$db_ndjson_file"
  jq -s '.' "$db_ndjson_file" >"$db_array_file"
  build_diff_payload_file "$scan_array_file" "$db_array_file" "$diff_file"

  jq -c '.[] | select(.registry_compatible == true)' "$scan_array_file" >"$compatible_ndjson_file"
  jq -c '.[] | select(.registry_compatible == false)' "$scan_array_file" >"$skipped_ndjson_file"

  while IFS= read -r compatible_entry; do
    [[ -z "$compatible_entry" ]] && continue

    local script_name
    local file_name
    local version
    local description
    local required_env_json
    local metadata_json
    local exists_in_db
    local needs_update
    local upsert_sql

    script_name="$(jq -r '.metadata.script_name' <<<"$compatible_entry")"
    file_name="$(jq -r '.metadata.file_name' <<<"$compatible_entry")"
    version="$(jq -r '.metadata.version // ""' <<<"$compatible_entry")"
    description="$(jq -r '.metadata.description // ""' <<<"$compatible_entry")"
    required_env_json="$(jq -cS '.metadata.required_env // []' <<<"$compatible_entry")"
    metadata_json="$(jq -cS '.metadata' <<<"$compatible_entry")"

    exists_in_db="$(jq -r --arg name "$script_name" 'map(select(.script_name == $name)) | length' "$db_array_file")"
    needs_update="$(
      jq -nr \
        --arg name "$script_name" \
        --slurpfile scan "$scan_array_file" \
        --slurpfile db "$db_array_file" \
        '
        ($scan[0] | map(select(.registry_compatible == true and .metadata.script_name == $name)) | .[0]) as $disk
        | ($db[0] | map(select(.script_name == $name)) | .[0]) as $row
        | if $row == null then
            false
          else
            (
              ($disk.metadata.file_name != $row.file_name)
              or (($disk.metadata.version // "") != ($row.version // ""))
              or (($disk.metadata.description // "") != ($row.description // ""))
              or (((($disk.metadata.required_env // []) | tojson)) != ((($row.required_env_json // []) | tojson)))
              or (((($disk.metadata // {}) | tojson)) != ((($row.metadata_json // {}) | tojson)))
              or (($row.is_active // true) != true)
            )
          end
        '
    )"

    if [[ "$exists_in_db" == "0" ]]; then
      if [[ "$dry_run" != "true" ]]; then
        upsert_sql="
          INSERT INTO jarvis_script_registry (
            script_name,
            file_name,
            version,
            description,
            required_env_json,
            metadata_json,
            is_active,
            updated_at
          ) VALUES (
            '$(sql_escape "$script_name")',
            '$(sql_escape "$file_name")',
            $(if [[ -n "$version" ]]; then printf "'%s'" "$(sql_escape "$version")"; else printf 'NULL'; fi),
            '$(sql_escape "$description")',
            '$(sql_escape "$required_env_json")'::jsonb,
            '$(sql_escape "$metadata_json")'::jsonb,
            TRUE,
            NOW()
          );
          $(build_history_insert_sql "$script_name" "insert" "$version" "$file_name" "$description" "$required_env_json" "$metadata_json" "TRUE")
        "
        if ! run_psql_query "$upsert_sql" >/dev/null; then
          jq -n \
            --arg script_name "$script_name" \
            --arg operation "insert" \
            --arg error "Database insert failed" \
            '{script_name: $script_name, operation: $operation, error: $error}' \
            >>"$errors_ndjson_file"
          continue
        fi
      fi

      jq -n \
        --arg script_name "$script_name" \
        --arg file_name "$file_name" \
        --arg version "$version" \
        --arg description "$description" \
        --argjson required_env_json "$required_env_json" \
        '{script_name: $script_name, file_name: $file_name, version: $version, description: $description, required_env_json: $required_env_json}' \
        >>"$inserted_ndjson_file"
      continue
    fi

    if [[ "$needs_update" == "true" ]]; then
      if [[ "$dry_run" != "true" ]]; then
        upsert_sql="
          UPDATE jarvis_script_registry
          SET
            file_name = '$(sql_escape "$file_name")',
            version = $(if [[ -n "$version" ]]; then printf "'%s'" "$(sql_escape "$version")"; else printf 'NULL'; fi),
            description = '$(sql_escape "$description")',
            required_env_json = '$(sql_escape "$required_env_json")'::jsonb,
            metadata_json = '$(sql_escape "$metadata_json")'::jsonb,
            is_active = TRUE,
            updated_at = NOW()
          WHERE script_name = '$(sql_escape "$script_name")';
          $(build_history_insert_sql "$script_name" "update" "$version" "$file_name" "$description" "$required_env_json" "$metadata_json" "TRUE")
        "
        if ! run_psql_query "$upsert_sql" >/dev/null; then
          jq -n \
            --arg script_name "$script_name" \
            --arg operation "update" \
            --arg error "Database update failed" \
            '{script_name: $script_name, operation: $operation, error: $error}' \
            >>"$errors_ndjson_file"
          continue
        fi
      fi

      jq -n \
        --arg script_name "$script_name" \
        --arg file_name "$file_name" \
        --arg version "$version" \
        --arg description "$description" \
        --argjson required_env_json "$required_env_json" \
        '{script_name: $script_name, file_name: $file_name, version: $version, description: $description, required_env_json: $required_env_json}' \
        >>"$updated_ndjson_file"
      continue
    fi

    jq -n \
      --arg script_name "$script_name" \
      --arg version "$version" \
      '{script_name: $script_name, version: $version}' \
      >>"$unchanged_ndjson_file"
  done <"$compatible_ndjson_file"

  if [[ "$disable_missing" == "true" ]]; then
    while IFS= read -r missing_entry; do
      [[ -z "$missing_entry" ]] && continue

      local missing_script_name
      missing_script_name="$(jq -r '.script_name' <<<"$missing_entry")"

      if [[ "$dry_run" != "true" ]]; then
        local disable_snapshot
        disable_snapshot="$(jq -cS --arg name "$missing_script_name" 'map(select(.script_name == $name)) | .[0] // {}' "$db_array_file")"

        if ! run_psql_query "
          UPDATE jarvis_script_registry
          SET
            is_active = FALSE,
            updated_at = NOW()
          WHERE script_name = '$(sql_escape "$missing_script_name")';
          $(build_history_insert_sql \
            "$missing_script_name" \
            "disable" \
            "$(jq -r '.version // ""' <<<"$disable_snapshot")" \
            "$(jq -r '.file_name // ""' <<<"$disable_snapshot")" \
            "$(jq -r '.description // ""' <<<"$disable_snapshot")" \
            "$(jq -cS '.required_env_json // []' <<<"$disable_snapshot")" \
            "$(jq -cS '.metadata_json // {}' <<<"$disable_snapshot")" \
            "FALSE")
        " >/dev/null; then
          jq -n \
            --arg script_name "$missing_script_name" \
            --arg operation "disable" \
            --arg error "Database disable failed" \
            '{script_name: $script_name, operation: $operation, error: $error}' \
            >>"$errors_ndjson_file"
          continue
        fi
      fi

      jq -n \
        --arg script_name "$missing_script_name" \
        --arg version "$(jq -r --arg name "$missing_script_name" 'map(select(.script_name == $name)) | .[0].version // ""' "$db_array_file")" \
        '{script_name: $script_name, version: $version}' \
        >>"$disabled_ndjson_file"
    done < <(jq -c '.missing_on_disk[]' "$diff_file")
  fi

  jq -n \
    --arg mode "sync-registry" \
    --arg scripts_root "$scripts_root" \
    --arg disable_missing "$disable_missing" \
    --arg dry_run "$dry_run" \
    --slurpfile inserted <(jq -s '.' "$inserted_ndjson_file") \
    --slurpfile updated <(jq -s '.' "$updated_ndjson_file") \
    --slurpfile disabled <(jq -s '.' "$disabled_ndjson_file") \
    --slurpfile unchanged <(jq -s '.' "$unchanged_ndjson_file") \
    --slurpfile skipped <(jq -s '.' "$skipped_ndjson_file") \
    --slurpfile errors <(jq -s '.' "$errors_ndjson_file") \
    '{
      ok: true,
      mode: $mode,
      scripts_root: $scripts_root,
      dry_run: ($dry_run == "true"),
      disable_missing: ($disable_missing == "true"),
      results: {
        inserted: $inserted[0],
        updated: $updated[0],
        disabled: $disabled[0],
        unchanged: $unchanged[0],
        skipped: $skipped[0],
        errors: $errors[0]
      },
      summary: (
        (($inserted[0] | length) | tostring) + " inserted, "
        + (($updated[0] | length) | tostring) + " updated, "
        + (($disabled[0] | length) | tostring) + " disabled, "
        + (($unchanged[0] | length) | tostring) + " unchanged, "
        + (($skipped[0] | length) | tostring) + " skipped"
      )
    }'
}

validate_registry_mode() {
  ensure_phase_for_mode "validate-registry" "collect"
  require_command jq
  require_db_prerequisites
  make_tmp_dir

  local scripts_root
  local scan_ndjson_file
  local scan_array_file
  local db_ndjson_file
  local db_array_file

  scripts_root="$(get_scripts_root)"
  [[ -d "$scripts_root" ]] || emit_json_error "Scripts directory not found" "Directory does not exist: ${scripts_root}" "validate-registry"
  scan_ndjson_file="${TMP_DIR}/validate-scan.ndjson"
  scan_array_file="${TMP_DIR}/validate-scan.json"
  db_ndjson_file="${TMP_DIR}/validate-db.ndjson"
  db_array_file="${TMP_DIR}/validate-db.json"

  scan_scripts_to_file "$scripts_root" "$scan_ndjson_file"
  jq -s '.' "$scan_ndjson_file" >"$scan_array_file"
  fetch_db_registry_to_file "$db_ndjson_file"
  jq -s '.' "$db_ndjson_file" >"$db_array_file"

  jq -n \
    --arg mode "validate-registry" \
    --arg scripts_root "$scripts_root" \
    --slurpfile scan "$scan_array_file" \
    --slurpfile db "$db_array_file" \
    '
    def compatible_scan:
      ($scan[0] | map(select(.registry_compatible == true)));
    def incompatible_scan:
      ($scan[0] | map(select(.registry_compatible == false)));
    {
      ok: true,
      mode: $mode,
      scripts_root: $scripts_root,
      db: {
        connected: true
      },
      diagnostics: {
        duplicate_disk_script_names: (
          compatible_scan
          | group_by(.metadata.script_name)
          | map(select(length > 1))
          | map({
              script_name: .[0].metadata.script_name,
              files: map(.file_name)
            })
        ),
        duplicate_db_file_names: (
          ($db[0] // [])
          | group_by(.file_name)
          | map(select(length > 1))
          | map({
              file_name: .[0].file_name,
              script_names: map(.script_name)
            })
        ),
        files_missing_on_disk: (
          ($db[0] // []) as $db_rows
          | ($scan[0] | map(.file_name)) as $disk_files
          | $db_rows
          | map(select(($disk_files | index(.file_name)) == null))
        ),
        scripts_without_registry_metadata: incompatible_scan,
        db_inactive_but_present_on_disk: (
          compatible_scan
          | map(. as $disk_row
            | select(
                any(($db[0] // [])[]; .script_name == $disk_row.metadata.script_name and (.is_active == false))
              )
          )
          | map({
              script_name: .metadata.script_name,
              file_name: .file_name
            })
        ),
        scripts_without_history: (
          compatible_scan
          | map(. as $disk_row
            | ($disk_row.metadata.script_name as $name
              | (($db[0] // []) | map(select(.script_name == $name)) | .[0]) as $db_row
              | select($db_row != null and (($db_row.history_count // 0) == 0))
            )
          )
          | map({
              script_name: .metadata.script_name,
              file_name: .file_name
            })
        ),
        required_env_malformed: (
          compatible_scan
          | map(select(
              any(.metadata.required_env[]?;
                if type == "string" then
                  (length == 0)
                elif type == "object" then
                  ((.name | type != "string") or ((.name | length) == 0))
                else
                  true
                end
              )
            ))
          | map({
              script_name: .metadata.script_name,
              file_name: .file_name
            })
        )
      }
    }
    | .summary = (
        ((.diagnostics.duplicate_disk_script_names | length) | tostring) + " duplicate disk names, "
        + ((.diagnostics.duplicate_db_file_names | length) | tostring) + " duplicate db file names, "
        + ((.diagnostics.files_missing_on_disk | length) | tostring) + " files missing on disk, "
        + ((.diagnostics.scripts_without_registry_metadata | length) | tostring) + " incompatible metadata, "
        + ((.diagnostics.scripts_without_history | length) | tostring) + " without history"
      )
    '
}

self_doc_mode() {
  ensure_phase_for_mode "self-doc" "collect"
  require_command jq

  jq -n \
    --arg script_name "$SCRIPT_BASENAME" \
    --arg file_name "$SCRIPT_BASENAME" \
    --arg description "Discover, diff, validate, and synchronize Jarvis script metadata with jarvis_script_registry." \
    --arg version "1.0.0" \
    --arg default_scripts_root "$SCRIPT_DIR" \
    '{
      ok: true,
      mode: "self-doc",
      script: {
        script_name: $script_name,
        file_name: $file_name,
        description: $description,
        version: $version,
        supports_registry: true,
        required_env: [
          {
            name: "JARVIS_DB_HOST",
            required: false,
            secret: false,
            description: "PostgreSQL host when db_url is not provided."
          },
          {
            name: "JARVIS_DB_PORT",
            required: false,
            secret: false,
            description: "PostgreSQL port when db_url is not provided."
          },
          {
            name: "JARVIS_DB_NAME",
            required: false,
            secret: false,
            description: "PostgreSQL database name when db_url is not provided."
          },
          {
            name: "JARVIS_DB_USER",
            required: false,
            secret: false,
            description: "PostgreSQL user when db_url is not provided."
          },
          {
            name: "JARVIS_DB_PASSWORD",
            required: false,
            secret: true,
            description: "PostgreSQL password when db_url is not provided."
          },
          {
            name: "JARVIS_DB_URL",
            required: false,
            secret: true,
            description: "PostgreSQL connection URL alternative to discrete db_* parameters."
          }
        ],
        services: [
          {
            name: "self-doc",
            phase: "collect",
            confirmed_required: false,
            description: "Return machine-readable documentation for the registry script."
          },
          {
            name: "scan-scripts",
            phase: "collect",
            confirmed_required: false,
            description: "Scan a scripts directory and collect registry-doc metadata."
          },
          {
            name: "describe-script",
            phase: "collect",
            confirmed_required: false,
            description: "Describe one discovered script."
          },
          {
            name: "diff-registry",
            phase: "collect",
            confirmed_required: false,
            description: "Compare disk metadata against jarvis_script_registry."
          },
          {
            name: "validate-registry",
            phase: "collect",
            confirmed_required: false,
            description: "Diagnose registry inconsistencies and metadata issues."
          },
          {
            name: "sync-registry",
            phase: "execute",
            confirmed_required: true,
            description: "Insert, update, and optionally disable registry rows from discovered metadata."
          }
        ],
        capabilities: [
          "filesystem-scan",
          "registry-doc-consumer",
          "postgres-diff",
          "postgres-sync",
          "registry-validation",
          "registry-versioning",
          "registry-history"
        ],
        tags: [
          "jarvis",
          "registry",
          "mcp",
          "bash"
        ]
      },
      runtime: {
        accepted_phase_values: ["collect", "execute"],
        accepted_params: [
          "mode",
          "scripts_root",
          "script_name",
          "db_host",
          "db_port",
          "db_name",
          "db_user",
          "db_password",
          "db_url",
          "disable_missing",
          "dry_run"
        ],
        default_scripts_root: $default_scripts_root,
        dependencies: [
          "bash",
          "jq",
          "psql (for diff-registry, sync-registry, validate-registry)"
        ]
      },
      registry_doc_contract: {
        ok: true,
        mode: "registry-doc",
        script: {
          script_name: "example-script",
          file_name: "example-script.sh",
          description: "Short machine-readable description.",
          version: "1.0.0",
          required_env: [
            {
              name: "EXAMPLE_TOKEN",
              required: true,
              secret: true,
              description: "API token used by the script."
            }
          ],
          supports_registry: true,
          services: [
            {
              name: "collect-data",
              phase: "collect",
              confirmed_required: false,
              description: "Collect data without side effects."
            }
          ],
          capabilities: [
            "collect-data"
          ],
          tags: [
            "example"
          ]
        }
      },
      summary: "Jarvis script registry self-documentation"
    }'
}

dispatch_mode() {
  local mode
  mode="$(param_or_default mode)"
  if [[ -z "$mode" ]]; then
    emit_json_error "Missing parameter" "Expected --param mode=..." "dispatch"
  fi

  case "$mode" in
    self-doc)
      self_doc_mode
      ;;
    scan-scripts)
      scan_scripts_mode
      ;;
    describe-script)
      describe_script_mode
      ;;
    diff-registry)
      diff_registry_mode
      ;;
    sync-registry)
      sync_registry_mode
      ;;
    validate-registry)
      validate_registry_mode
      ;;
    *)
      emit_json_error "Unsupported mode" "Unknown mode: ${mode}" "$mode"
      ;;
  esac
}

main() {
  parse_args "$@"
  dispatch_mode
}

main "$@"
