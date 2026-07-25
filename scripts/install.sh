#!/usr/bin/env bash
# Build this integrated fork and transactionally register it with MCP clients.
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
REGISTER_CODEX=false
REGISTER_CLAUDE=false
AUDIO_ROOTS=()
ROLLBACK_DIR=""
ROLLBACK_NEEDED=false
CODEX_CONFIG_FILE="${CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"
CLAUDE_CONFIG_FILE="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"
declare -a BACKUP_FILES=()
declare -a BACKUP_EXISTED=()
declare -a BACKUP_DIGESTS=()
declare -a EXPECTED_DIGESTS=()
declare -a BACKUP_MODES=()
declare -a BACKUP_AUTO_RESTORE=()
declare -a CLIENTS=()
declare -a TARGET_CLASSES=()
declare -a UPSTREAM_CLASSES=()
declare -a TARGET_COMMANDS=()
declare -a TARGET_ARGS=()
declare -a UPSTREAM_COMMANDS=()
declare -a UPSTREAM_ARGS=()
declare -a TARGET_MUTATED=()
declare -a UPSTREAM_MUTATED=()
CLI_MUTATION_OCCURRED=false

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [--codex] [--claude] [--all] [--audio-root PATH ...]

Builds and tests this integrated fork, then optionally registers its launcher.
The installer inventories existing registrations, refuses unknown same-name
entries, registers and verifies the custom MCP before removing known upstream
duplicates, and transactionally backs up all configuration it may change.
EOF
}

while (( $# )); do
  arg="$1"; shift
  case "$arg" in
    --codex) REGISTER_CODEX=true ;;
    --claude) REGISTER_CLAUDE=true ;;
    --all) REGISTER_CODEX=true; REGISTER_CLAUDE=true ;;
    --audio-root)
      (( $# )) || { echo "--audio-root requires PATH" >&2; exit 2; }
      AUDIO_ROOTS+=("$1"); shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js 22.13+ is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
NODE_COMMAND="$(command -v node)"
NODE_BIN="$(cd -- "$(dirname -- "$NODE_COMMAND")" && pwd -P)/$(basename -- "$NODE_COMMAND")"
"$NODE_BIN" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)' ||
  { echo "Node.js 22.13+ is required; found $("$NODE_BIN" --version)." >&2; exit 1; }

cd "$ROOT_DIR"
# Lifecycle scripts from dependencies are intentionally disabled.  The fork's
# own build, static checks, and complete test suite are explicit gates.
npm ci --ignore-scripts
npm run build
npm run check
npm test

if ! "$REGISTER_CODEX" && ! "$REGISTER_CLAUDE"; then
  echo "Built and tested the integrated fork; no MCP client registration requested."
  exit 0
fi

if "$REGISTER_CODEX" && ! command -v codex >/dev/null; then
  echo "Codex CLI was not found." >&2
  exit 1
fi
if "$REGISTER_CLAUDE" && ! command -v claude >/dev/null; then
  echo "Claude Code CLI was not found." >&2
  exit 1
fi
(( ${#AUDIO_ROOTS[@]} )) ||
  { echo "Registration requires one or more --audio-root PATH values." >&2; exit 2; }

canonical_roots=()
for root in "${AUDIO_ROOTS[@]}"; do
  [[ -d "$root" ]] || { echo "Audio root is not a directory: $root" >&2; exit 2; }
  canonical="$(cd -- "$root" && pwd -P)"
  [[ "$canonical" != *:* ]] ||
    { echo "Audio root cannot contain a colon: $canonical" >&2; exit 2; }
  [[ ! "$canonical" =~ [[:cntrl:]] ]] ||
    { echo "Audio root cannot contain control characters." >&2; exit 2; }
  canonical_roots+=("$canonical")
done
roots_value="$(IFS=:; printf '%s' "${canonical_roots[*]}")"

state_digest() {
  local path="$1" file_hash
  if [[ -L "$path" ]]; then
    printf 'SYMLINK:%s' "$(readlink "$path")"
  elif [[ -f "$path" ]]; then
    file_hash="$("$NODE_BIN" -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$path")"
    printf 'FILE:%s:%s:%s' "$file_hash" "$(file_owner "$path")" "$(file_mode "$path")"
  elif [[ -e "$path" ]]; then
    printf 'OTHER'
  else
    printf 'MISSING'
  fi
}

file_mode() {
  if [[ "$(uname -s)" == Darwin ]]; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}

file_owner() {
  if [[ "$(uname -s)" == Darwin ]]; then stat -f '%u' "$1"; else stat -c '%u' "$1"; fi
}

backup_config() {
  local file="$1" auto_restore="${2:-false}" index="${#BACKUP_FILES[@]}" digest
  [[ ! -L "$file" ]] || { echo "Refusing symbolic-link configuration: $file" >&2; exit 1; }
  [[ ! -e "$file" || -f "$file" ]] ||
    { echo "Refusing non-regular configuration: $file" >&2; exit 1; }
  if [[ -f "$file" && "$(file_owner "$file")" != "$(id -u)" ]]; then
    echo "Refusing configuration owned by another user: $file" >&2
    exit 1
  fi
  digest="$(state_digest "$file")"
  BACKUP_FILES+=("$file")
  BACKUP_DIGESTS+=("$digest")
  EXPECTED_DIGESTS+=("$digest")
  BACKUP_AUTO_RESTORE+=("$auto_restore")
  if [[ -f "$file" ]]; then
    BACKUP_EXISTED+=(true)
    BACKUP_MODES+=("$(file_mode "$file")")
    cp -p -- "$file" "$ROLLBACK_DIR/$index"
    [[ "$(state_digest "$ROLLBACK_DIR/$index")" == "$digest" ]] ||
      { echo "Backup checksum verification failed: $file" >&2; exit 1; }
  else
    BACKUP_EXISTED+=(false)
    BACKUP_MODES+=("")
  fi
}

mark_expected() {
  local file="$1" expected_digest="${2:-}" index
  [[ -n "$expected_digest" ]] || expected_digest="$(state_digest "$file")"
  for ((index = 0; index < ${#BACKUP_FILES[@]}; index++)); do
    if [[ "${BACKUP_FILES[$index]}" == "$file" ]]; then
      EXPECTED_DIGESTS[index]="$expected_digest"
      return
    fi
  done
  echo "Internal error: untracked transactional file $file" >&2
  return 1
}

restore_configs() {
  local index file current failures=0
  for ((index = 0; index < ${#BACKUP_FILES[@]}; index++)); do
    file="${BACKUP_FILES[$index]}"
    [[ "${BACKUP_AUTO_RESTORE[$index]}" == true ]] || continue
    current="$(state_digest "$file")"
    if [[ "$current" != "${EXPECTED_DIGESTS[$index]}" ]]; then
      echo "Rollback skipped concurrent change: $file" >&2
      failures=$((failures + 1))
      continue
    fi
    if [[ "${BACKUP_EXISTED[$index]}" == true ]]; then
      mkdir -p -- "$(dirname -- "$file")"
      cp -p -- "$ROLLBACK_DIR/$index" "$file"
    else
      rm -f -- "$file"
    fi
    if [[ "$(state_digest "$file")" != "${BACKUP_DIGESTS[$index]}" ]]; then
      echo "Rollback checksum verification failed: $file" >&2
      failures=$((failures + 1))
    elif [[ "${BACKUP_EXISTED[$index]}" == true && "$(file_mode "$file")" != "${BACKUP_MODES[$index]}" ]]; then
      echo "Rollback mode verification failed: $file" >&2
      failures=$((failures + 1))
    fi
  done
  (( failures == 0 ))
}

cleanup_registration() {
  local status="$?" semantic_ok=true restore_ok=true
  if "$ROLLBACK_NEEDED"; then
    echo "Registration failed; attempting checksum-aware rollback." >&2
    if "$CLI_MUTATION_OCCURRED" && declare -F rollback_registrations >/dev/null; then
      rollback_registrations || semantic_ok=false
    fi
    restore_configs || restore_ok=false
    if "$semantic_ok" && "$restore_ok"; then
      rm -rf -- "$ROLLBACK_DIR"
      ROLLBACK_DIR=""
    else
      echo "Rollback preserved one or more concurrent changes; backups remain in $ROLLBACK_DIR" >&2
    fi
    return "$status"
  fi
  [[ -z "$ROLLBACK_DIR" ]] || rm -rf -- "$ROLLBACK_DIR"
}

client_get() {
  local client="$1" name="$2"
  if [[ "$client" == codex ]]; then
    codex mcp get "$name"
  else
    claude mcp get "$name"
  fi
}

extract_command() {
  local output="$1" line
  while IFS= read -r line; do
    case "$line" in
      "  command: "*) printf '%s' "${line#  command: }"; return ;;
      "  Command: "*) printf '%s' "${line#  Command: }"; return ;;
    esac
  done <<< "$output"
}

extract_args() {
  local output="$1" line
  while IFS= read -r line; do
    case "$line" in
      "  args: "*) printf '%s' "${line#  args: }"; return ;;
      "  Args: "*) printf '%s' "${line#  Args: }"; return ;;
    esac
  done <<< "$output"
}

registration_env_is_empty() {
  local output="$1" line saw=false after_claude_env=false
  while IFS= read -r line; do
    case "$line" in
      "  env: -") saw=true ;;
      "  env: "*) return 1 ;;
      "  Environment:")
        saw=true
        after_claude_env=true
        ;;
      "  Environment: "*) return 1 ;;
      "    "*)
        "$after_claude_env" && return 1
        ;;
      *) "$after_claude_env" && after_claude_env=false ;;
    esac
  done <<< "$output"
  "$saw"
}

safe_candidate_git() {
  git \
    -c core.fsmonitor=false \
    -c core.hooksPath=/dev/null \
    -c core.attributesFile=/dev/null \
    -c diff.external= \
    -c pager.show=false \
    "$@"
}

trusted_release_candidate() {
  local kind="$1" package_root="$2" details version commit repository tag_output head
  [[ -f "$ROOT_DIR/TRUSTED_RELEASES.json" ]] || return 1
  # shellcheck disable=SC2016
  details="$("$NODE_BIN" -e '
    const fs=require("node:fs"), crypto=require("node:crypto"), path=require("node:path");
    try {
      const [manifestPath, kind, root]=process.argv.slice(1);
      const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
      const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
      const releases=kind==="custom"?manifest.customReleases:manifest.upstreamReleases;
      const release=releases?.[pkg.version];
      if (!release || !/^[0-9a-f]{40}$/.test(release.commit)) process.exit(2);
      for (const [relative, expected] of Object.entries(release.files||{})) {
        const candidate=path.join(root,relative);
        const stat=fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid()) process.exit(3);
        const actual=crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
        if (actual!==expected) process.exit(4);
      }
      process.stdout.write(`${pkg.version}\t${release.commit}`);
    } catch { process.exit(5); }
  ' "$ROOT_DIR/TRUSTED_RELEASES.json" "$kind" "$package_root")" || return 1
  IFS=$'\t' read -r version commit <<< "$details"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  head="$(safe_candidate_git -C "$package_root" rev-parse HEAD 2>/dev/null)" || return 1
  [[ "$head" == "$commit" ]] || return 1
  if [[ "$kind" == custom ]]; then
    repository="https://github.com/sasuketorii/notebooklm_mcp_with.git"
  else
    repository="https://github.com/PleasePrompto/notebooklm-mcp.git"
  fi
  tag_output="$(
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
      git -c credential.helper= ls-remote "$repository" \
        "refs/tags/v$version" "refs/tags/v$version^{}" 2>/dev/null
  )" || return 1
  while IFS=$'\t' read -r remote_commit remote_ref; do
    if [[ "$remote_commit" == "$commit" &&
          ( "$remote_ref" == "refs/tags/v$version" || "$remote_ref" == "refs/tags/v$version^{}" ) ]]; then
      return 0
    fi
  done <<< "$tag_output"
  return 1
}

classify_registration() {
  local output="$1" command args package_root
  command="$(extract_command "$output")"
  args="$(extract_args "$output")"
  [[ -n "$command" ]] || { printf 'unknown'; return; }
  registration_env_is_empty "$output" || { printf 'unknown'; return; }
  if [[ "$command" == "$ROOT_DIR/scripts/mcp-launcher.sh" &&
        ! -L "$command" && -f "$command" && -x "$command" &&
        "$(file_owner "$command")" == "$(id -u)" &&
        ( -z "$args" || "$args" == "-" ) ]]; then
    printf 'exact_custom'
    return
  fi
  if [[ "$command" == /*/scripts/mcp-launcher.sh && ! -L "$command" &&
        -f "$command" && -x "$command" && "$(file_owner "$command")" == "$(id -u)" &&
        ( -z "$args" || "$args" == "-" ) ]]; then
    package_root="${command%/scripts/mcp-launcher.sh}"
    if trusted_release_candidate custom "$package_root"; then
      printf 'known_custom'
      return
    fi
    printf 'unknown'
    return
  fi
  if [[ "$command" == npx && \
        "$args" =~ ^(-y[[:space:]]+)?notebooklm-mcp@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'known_upstream'
    return
  fi
  if [[ "$command" == /*/dist/index.js && ! -L "$command" && -f "$command" &&
        -x "$command" && "$(file_owner "$command")" == "$(id -u)" &&
        ( -z "$args" || "$args" == "-" ) ]]; then
    package_root="${command%/dist/index.js}"
    if trusted_release_candidate upstream "$package_root"; then
      printf 'known_upstream'
      return
    fi
  fi
  printf 'unknown'
}

inventory_registration() {
  local client="$1" name="$2" output absent_single absent_double
  absent_single="No MCP server named '$name' found."
  absent_double="No MCP server named \"$name\"."
  if output="$(client_get "$client" "$name" 2>&1)"; then
    classify_registration "$output"
    return
  fi
  if [[ "$output" == *"$absent_single"* || "$output" == *"$absent_double"* ]]; then
    printf 'absent'
    return
  fi
  echo "Could not inventory $client registration $name: CLI get failed without an absent result." >&2
  return 1
}

"$REGISTER_CODEX" && CLIENTS+=(codex)
"$REGISTER_CLAUDE" && CLIENTS+=(claude)

# Inventory every requested client before changing any file or registration.
for client in "${CLIENTS[@]}"; do
  target_class="$(inventory_registration "$client" notebooklm-audio)"
  upstream_class="$(inventory_registration "$client" notebooklm)"
  [[ "$target_class" != unknown ]] ||
    { echo "Refusing unknown $client registration named notebooklm-audio." >&2; exit 1; }
  [[ "$upstream_class" != unknown ]] ||
    { echo "Refusing unknown $client registration named notebooklm." >&2; exit 1; }
  TARGET_CLASSES+=("$target_class")
  UPSTREAM_CLASSES+=("$upstream_class")
  if [[ "$target_class" == absent ]]; then
    TARGET_COMMANDS+=("")
    TARGET_ARGS+=("")
  else
    output="$(client_get "$client" notebooklm-audio 2>&1)"
    [[ "$(classify_registration "$output")" == "$target_class" ]] ||
      { echo "$client target registration changed during inventory." >&2; exit 1; }
    TARGET_COMMANDS+=("$(extract_command "$output")")
    TARGET_ARGS+=("$(extract_args "$output")")
  fi
  if [[ "$upstream_class" == absent ]]; then
    UPSTREAM_COMMANDS+=("")
    UPSTREAM_ARGS+=("")
  else
    output="$(client_get "$client" notebooklm 2>&1)"
    [[ "$(classify_registration "$output")" == "$upstream_class" ]] ||
      { echo "$client upstream registration changed during inventory." >&2; exit 1; }
    UPSTREAM_COMMANDS+=("$(extract_command "$output")")
    UPSTREAM_ARGS+=("$(extract_args "$output")")
  fi
  TARGET_MUTATED+=(none)
  UPSTREAM_MUTATED+=(false)
done

ROLLBACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-mcp-audio.XXXXXX")"
trap cleanup_registration EXIT
"$REGISTER_CODEX" && backup_config "$CODEX_CONFIG_FILE" false
"$REGISTER_CLAUDE" && backup_config "$CLAUDE_CONFIG_FILE" false
backup_config "$ROOT_DIR/.audio-roots.env" true
ROLLBACK_NEEDED=true

# shellcheck disable=SC1090,SC1091
source "$ROOT_DIR/scripts/read-private-env.sh"
existing_http_token=""
if private_env_load "$ROOT_DIR/.audio-roots.env" 2>/dev/null; then
  existing_http_token="$NOTEBOOKLM_HTTP_BEARER_TOKEN"
fi
if [[ ${#existing_http_token} -lt 32 ]]; then
  existing_http_token="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
fi
env_temp="$(mktemp "$ROOT_DIR/.audio-roots.env.XXXXXX")"
{
  printf 'NOTEBOOKLM_NODE_BIN=%s\n' "$NODE_BIN"
  printf 'NOTEBOOKLM_AUDIO_ROOTS=%s\n' "$roots_value"
  printf 'NOTEBOOKLM_HTTP_BEARER_TOKEN=%s\n' "$existing_http_token"
} > "$env_temp"
chmod 600 "$env_temp"
env_expected_digest="$(state_digest "$env_temp")"
mv -- "$env_temp" "$ROOT_DIR/.audio-roots.env"
mark_expected "$ROOT_DIR/.audio-roots.env" "$env_expected_digest"

client_remove_raw() {
  local client="$1" name="$2"
  if [[ "$client" == codex ]]; then
    codex mcp remove "$name"
  else
    claude mcp remove "$name" -s user
  fi
}

client_add_custom_raw() {
  local client="$1"
  if [[ "$client" == codex ]]; then
    codex mcp add notebooklm-audio -- "$ROOT_DIR/scripts/mcp-launcher.sh"
  else
    claude mcp add --scope user notebooklm-audio -- "$ROOT_DIR/scripts/mcp-launcher.sh"
  fi
}

client_add_original_raw() {
  local client="$1" name="$2" command="$3" args="$4"
  local -a original_args=()
  [[ -z "$args" || "$args" == "-" ]] || read -r -a original_args <<< "$args"
  if [[ "$client" == codex ]]; then
    codex mcp add "$name" -- "$command" "${original_args[@]}"
  else
    claude mcp add --scope user "$name" -- "$command" "${original_args[@]}"
  fi
}

remove_target_observed() {
  local i="$1" client="$2" rc=0 current
  if client_remove_raw "$client" notebooklm-audio; then
    # A successful mutating CLI call must be treated as a mutation even when
    # its immediate read-back fails transiently.  The EXIT trap can then
    # conservatively restore the preflighted registration.
    TARGET_MUTATED[i]=removed
    CLI_MUTATION_OCCURRED=true
  else
    rc=$?
  fi
  current="$(inventory_registration "$client" notebooklm-audio 2>/dev/null || printf unknown)"
  if [[ "$current" == absent ]]; then
    TARGET_MUTATED[i]=removed
    CLI_MUTATION_OCCURRED=true
  elif [[ "$current" != "${TARGET_CLASSES[$i]}" ]]; then
    echo "$client target changed unexpectedly during removal." >&2
    return 1
  fi
  (( rc == 0 )) && [[ "$current" == absent ]]
}

add_custom_observed() {
  local i="$1" client="$2" rc=0 current
  if client_add_custom_raw "$client"; then
    # Record success before read-back.  A get failure must not erase evidence
    # that the CLI has already changed external configuration.
    TARGET_MUTATED[i]=installed
    CLI_MUTATION_OCCURRED=true
  else
    rc=$?
  fi
  current="$(inventory_registration "$client" notebooklm-audio 2>/dev/null || printf unknown)"
  if [[ "$current" == exact_custom ]]; then
    TARGET_MUTATED[i]=installed
    CLI_MUTATION_OCCURRED=true
  elif [[ "$current" != absent ]]; then
    echo "$client target changed unexpectedly during custom add." >&2
    return 1
  fi
  (( rc == 0 )) && [[ "$current" == exact_custom ]]
}

remove_upstream_observed() {
  local i="$1" client="$2" rc=0 current
  if client_remove_raw "$client" notebooklm; then
    UPSTREAM_MUTATED[i]=true
    CLI_MUTATION_OCCURRED=true
  else
    rc=$?
  fi
  current="$(inventory_registration "$client" notebooklm 2>/dev/null || printf unknown)"
  if [[ "$current" == absent ]]; then
    UPSTREAM_MUTATED[i]=true
    CLI_MUTATION_OCCURRED=true
  elif [[ "$current" != "${UPSTREAM_CLASSES[$i]}" ]]; then
    echo "$client upstream changed unexpectedly during removal." >&2
    return 1
  fi
  (( rc == 0 )) && [[ "$current" == absent ]]
}

registration_matches_original() {
  local client="$1" name="$2" expected_command="$3" expected_args="$4" output
  output="$(client_get "$client" "$name" 2>&1)" || return 1
  registration_env_is_empty "$output" &&
    [[ "$(extract_command "$output")" == "$expected_command" &&
       "$(extract_args "$output")" == "$expected_args" ]]
}

rollback_registrations() {
  local i client current failures=0
  for ((i = ${#CLIENTS[@]} - 1; i >= 0; i--)); do
    client="${CLIENTS[$i]}"
    if [[ "${UPSTREAM_MUTATED[$i]}" == true ]]; then
      current="$(inventory_registration "$client" notebooklm 2>/dev/null || printf unknown)"
      if [[ "$current" == absent ]]; then
        if ! client_add_original_raw "$client" notebooklm "${UPSTREAM_COMMANDS[$i]}" "${UPSTREAM_ARGS[$i]}"; then
          echo "Semantic rollback failed to restore $client notebooklm." >&2
          failures=$((failures + 1))
        elif ! registration_matches_original "$client" notebooklm "${UPSTREAM_COMMANDS[$i]}" "${UPSTREAM_ARGS[$i]}"; then
          echo "Semantic rollback read-back failed for $client notebooklm." >&2
          failures=$((failures + 1))
        fi
      else
        echo "Semantic rollback skipped concurrently changed $client notebooklm." >&2
        failures=$((failures + 1))
      fi
    fi
    if [[ "${TARGET_MUTATED[$i]}" == installed ]]; then
      current="$(inventory_registration "$client" notebooklm-audio 2>/dev/null || printf unknown)"
      if [[ "$current" == exact_custom ]]; then
        if client_remove_raw "$client" notebooklm-audio; then
          if [[ "${TARGET_CLASSES[$i]}" == absent ]]; then
            if [[ "$(inventory_registration "$client" notebooklm-audio 2>/dev/null || printf unknown)" != absent ]]; then
              echo "Semantic rollback absence read-back failed for $client notebooklm-audio." >&2
              failures=$((failures + 1))
            fi
          elif ! client_add_original_raw "$client" notebooklm-audio "${TARGET_COMMANDS[$i]}" "${TARGET_ARGS[$i]}" ||
               ! registration_matches_original "$client" notebooklm-audio "${TARGET_COMMANDS[$i]}" "${TARGET_ARGS[$i]}"; then
              echo "Semantic rollback failed or read-back mismatched for $client notebooklm-audio." >&2
              failures=$((failures + 1))
          fi
        else
          echo "Semantic rollback failed to remove installed $client notebooklm-audio." >&2
          failures=$((failures + 1))
        fi
      else
        echo "Semantic rollback skipped concurrently changed $client notebooklm-audio." >&2
        failures=$((failures + 1))
      fi
    elif [[ "${TARGET_MUTATED[$i]}" == removed ]]; then
      current="$(inventory_registration "$client" notebooklm-audio 2>/dev/null || printf unknown)"
      if [[ "$current" == absent && "${TARGET_CLASSES[$i]}" != absent ]]; then
        if ! client_add_original_raw "$client" notebooklm-audio "${TARGET_COMMANDS[$i]}" "${TARGET_ARGS[$i]}"; then
          echo "Semantic rollback failed to restore removed $client notebooklm-audio." >&2
          failures=$((failures + 1))
        elif ! registration_matches_original "$client" notebooklm-audio "${TARGET_COMMANDS[$i]}" "${TARGET_ARGS[$i]}"; then
          echo "Semantic rollback read-back failed for removed $client notebooklm-audio." >&2
          failures=$((failures + 1))
        fi
      else
        echo "Semantic rollback skipped concurrently changed $client notebooklm-audio." >&2
        failures=$((failures + 1))
      fi
    fi
  done
  (( failures == 0 ))
}

for ((i = 0; i < ${#CLIENTS[@]}; i++)); do
  client="${CLIENTS[$i]}"
  target_class="${TARGET_CLASSES[$i]}"
  upstream_class="${UPSTREAM_CLASSES[$i]}"

  if [[ "$target_class" != exact_custom ]]; then
    if [[ "$target_class" != absent ]]; then
      remove_target_observed "$i" "$client"
    fi
    add_custom_observed "$i" "$client"
  fi

  output="$(client_get "$client" notebooklm-audio 2>&1)"
  [[ "$(classify_registration "$output")" == exact_custom ]] ||
    { echo "$client custom registration read-back did not match the launcher." >&2; exit 1; }

  # A known duplicate is removed only after the integrated custom registration
  # has been read back successfully.
  if [[ "$upstream_class" != absent ]]; then
    remove_upstream_observed "$i" "$client"
  fi
  if [[ "$upstream_class" != absent ]]; then
    [[ "$(inventory_registration "$client" notebooklm)" == absent ]] ||
      { echo "$client upstream duplicate still exists after removal." >&2; exit 1; }
  fi
done

ROLLBACK_NEEDED=false
rm -rf -- "$ROLLBACK_DIR"
ROLLBACK_DIR=""
echo "Installed and verified integrated MCP launcher: $ROOT_DIR/scripts/mcp-launcher.sh"
echo "Next: call setup_auth with show_browser=true using the same OS user."
