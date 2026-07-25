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
declare -a INSTALLED_TARGET_COMMANDS=()
declare -a INSTALLED_TARGET_ARGS=()
declare -a LOCK_PATHS=()
declare -a LOCK_TOKENS=()
declare -a LOCK_IDENTITIES=()
declare -a LOCK_CLIENTS=()
CLI_MUTATION_OCCURRED=false
LOCK_RELEASE_ATTEMPTED=false

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

file_identity() {
  if [[ "$(uname -s)" == Darwin ]]; then stat -f '%d:%i' "$1"; else stat -c '%d:%i' "$1"; fi
}

release_client_locks() {
  local index lock token owner_file failures=0
  LOCK_RELEASE_ATTEMPTED=true
  for ((index = ${#LOCK_PATHS[@]} - 1; index >= 0; index--)); do
    lock="${LOCK_PATHS[$index]}"
    token="${LOCK_TOKENS[$index]}"
    owner_file="$lock/owner"
    if [[ -L "$lock" || ! -d "$lock" ||
          "$(file_owner "$lock" 2>/dev/null || true)" != "$(id -u)" ||
          "$(file_mode "$lock" 2>/dev/null || true)" != 700 ||
          "$(file_identity "$lock" 2>/dev/null || true)" != "${LOCK_IDENTITIES[$index]}" ||
          -L "$owner_file" || ! -f "$owner_file" ||
          "$(file_owner "$owner_file" 2>/dev/null || true)" != "$(id -u)" ||
          "$(file_mode "$owner_file" 2>/dev/null || true)" != 600 ||
          "$(sed -n '1p' "$owner_file" 2>/dev/null || true)" != "$token" ]]; then
      echo "Installer lock ownership changed; refusing release: $lock" >&2
      failures=$((failures + 1))
      continue
    fi
    if ! "$NODE_BIN" -e '
      const fs = require("node:fs");
      const entries = fs.readdirSync(process.argv[1]);
      process.exit(entries.length === 1 && entries[0] === "owner" ? 0 : 1);
    ' "$lock"; then
      echo "Installer lock contains unexpected state; preserving evidence: $lock" >&2
      failures=$((failures + 1))
      continue
    fi
    if ! rm -f -- "$owner_file"; then
      echo "Installer lock owner metadata could not be removed: $owner_file" >&2
      failures=$((failures + 1))
      continue
    fi
    if ! rmdir -- "$lock"; then
      # A same-user writer may race after the exact-content check. Recreate our
      # owner evidence without overwriting anything, then leave the lock for
      # manual inspection.
      if [[ ! -e "$owner_file" && ! -L "$owner_file" ]]; then
        (
          set -o noclobber
          {
            printf '%s\n' "$token"
            printf 'pid=%s\n' "$$"
            printf 'client=%s\n' "${LOCK_CLIENTS[$index]}"
          } > "$owner_file"
          chmod 600 "$owner_file"
        ) 2>/dev/null || true
      fi
      echo "Installer lock changed during release; preserving evidence: $lock" >&2
      failures=$((failures + 1))
    fi
  done
  (( failures == 0 ))
}

acquire_client_lock() {
  local client="$1" config_file="$2" parent physical_parent lock token owner_file
  [[ "$config_file" == /* && ! "$config_file" =~ [[:cntrl:]] ]] ||
    { echo "Refusing non-absolute or control-character $client config path." >&2; return 1; }
  parent="$(dirname -- "$config_file")"
  [[ -d "$parent" && ! -L "$parent" ]] ||
    { echo "Refusing missing, non-directory, or symlinked $client config parent: $parent" >&2; return 1; }
  [[ "$(file_owner "$parent")" == "$(id -u)" ]] ||
    { echo "Refusing $client config parent owned by another user: $parent" >&2; return 1; }
  physical_parent="$(cd -- "$parent" && pwd -P)"
  [[ "$physical_parent" == "$parent" ]] ||
    { echo "Refusing $client config path containing a symlink: $parent" >&2; return 1; }
  lock="$parent/.$(basename -- "$config_file").notebooklm-audio-install.lock"
  if ! mkdir -- "$lock" 2>/dev/null; then
    echo "Another installer may own the $client transaction lock: $lock" >&2
    echo "The lock is never auto-broken; verify the owner and remove it manually only after all installers stop." >&2
    return 1
  fi
  chmod 700 "$lock"
  if [[ -L "$lock" || ! -d "$lock" ||
        "$(file_owner "$lock")" != "$(id -u)" ||
        "$(file_mode "$lock")" != 700 ]]; then
    echo "New $client installer lock failed ownership/type/mode verification: $lock" >&2
    return 1
  fi
  token="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  owner_file="$lock/owner"
  {
    printf '%s\n' "$token"
    printf 'pid=%s\n' "$$"
    printf 'client=%s\n' "$client"
  } > "$owner_file"
  chmod 600 "$owner_file"
  [[ ! -L "$owner_file" && -f "$owner_file" &&
     "$(file_owner "$owner_file")" == "$(id -u)" &&
     "$(file_mode "$owner_file")" == 600 ]] ||
    { echo "New $client installer lock metadata failed verification: $owner_file" >&2; return 1; }
  LOCK_PATHS+=("$lock")
  LOCK_TOKENS+=("$token")
  LOCK_IDENTITIES+=("$(file_identity "$lock")")
  LOCK_CLIENTS+=("$client")
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
      return 0
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
  local status="$?" semantic_ok=true restore_ok=true locks_ok=true
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
    if ! "$LOCK_RELEASE_ATTEMPTED"; then
      release_client_locks || locks_ok=false
    fi
    "$locks_ok" || echo "One or more installer locks require manual inspection." >&2
    if (( status == 0 )) && { ! "$semantic_ok" || ! "$restore_ok" || ! "$locks_ok"; }; then
      status=1
    fi
    return "$status"
  fi
  [[ -z "$ROLLBACK_DIR" ]] || rm -rf -- "$ROLLBACK_DIR"
  if ! "$LOCK_RELEASE_ATTEMPTED"; then
    release_client_locks || locks_ok=false
  fi
  "$locks_ok" || echo "One or more installer locks require manual inspection." >&2
  if (( status == 0 )) && ! "$locks_ok"; then
    status=1
  fi
  return "$status"
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
      "  command: "*) printf '%s' "${line#  command: }"; return 0 ;;
      "  Command: "*) printf '%s' "${line#  Command: }"; return 0 ;;
    esac
  done <<< "$output"
}

extract_args() {
  local output="$1" line
  while IFS= read -r line; do
    case "$line" in
      "  args: "*) printf '%s' "${line#  args: }"; return 0 ;;
      "  Args: "*) printf '%s' "${line#  Args: }"; return 0 ;;
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
  [[ -n "$command" ]] || { printf 'unknown'; return 0; }
  registration_env_is_empty "$output" || { printf 'unknown'; return 0; }
  if [[ "$command" == "$ROOT_DIR/scripts/mcp-launcher.sh" &&
        ! -L "$command" && -f "$command" && -x "$command" &&
        "$(file_owner "$command")" == "$(id -u)" &&
        ( -z "$args" || "$args" == "-" ) ]]; then
    printf 'exact_custom'
    return 0
  fi
  if [[ "$command" == /*/scripts/mcp-launcher.sh && ! -L "$command" &&
        -f "$command" && -x "$command" && "$(file_owner "$command")" == "$(id -u)" &&
        ( -z "$args" || "$args" == "-" ) ]]; then
    package_root="${command%/scripts/mcp-launcher.sh}"
    if trusted_release_candidate custom "$package_root"; then
      printf 'known_custom'
      return 0
    fi
    printf 'unknown'
    return 0
  fi
  if [[ "$command" == npx && \
        "$args" =~ ^(-y[[:space:]]+)?notebooklm-mcp@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'known_upstream'
    return 0
  fi
  if [[ "$command" == /*/dist/index.js && ! -L "$command" && -f "$command" &&
        -x "$command" && "$(file_owner "$command")" == "$(id -u)" &&
        ( -z "$args" || "$args" == "-" ) ]]; then
    package_root="${command%/dist/index.js}"
    if trusted_release_candidate upstream "$package_root"; then
      printf 'known_upstream'
      return 0
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
    return 0
  fi
  if [[ "$output" == *"$absent_single"* || "$output" == *"$absent_double"* ]]; then
    printf 'absent'
    return 0
  fi
  echo "Could not inventory $client registration $name: CLI get failed without an absent result." >&2
  return 1
}

"$REGISTER_CODEX" && CLIENTS+=(codex)
"$REGISTER_CLAUDE" && CLIENTS+=(claude)

# Acquire every requested client's atomic transaction lock in deterministic
# client order before the first inventory read. Locks remain held through
# mutation, read-back, and rollback. Existing locks are never treated as stale
# or broken automatically, even when their optional PID metadata is old.
trap cleanup_registration EXIT
for client in "${CLIENTS[@]}"; do
  if [[ "$client" == codex ]]; then
    acquire_client_lock "$client" "$CODEX_CONFIG_FILE"
  else
    acquire_client_lock "$client" "$CLAUDE_CONFIG_FILE"
  fi
done

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
  INSTALLED_TARGET_COMMANDS+=("")
  INSTALLED_TARGET_ARGS+=("")
done

ROLLBACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-mcp-audio.XXXXXX")"
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
  local i="$1" client="$2" rc=0 current output
  if client_add_custom_raw "$client"; then
    # Record success before read-back.  A get failure must not erase evidence
    # that the CLI has already changed external configuration.
    TARGET_MUTATED[i]=installed
    CLI_MUTATION_OCCURRED=true
    INSTALLED_TARGET_COMMANDS[i]="$ROOT_DIR/scripts/mcp-launcher.sh"
    INSTALLED_TARGET_ARGS[i]=""
  else
    rc=$?
  fi
  if output="$(client_get "$client" notebooklm-audio 2>/dev/null)"; then
    current="$(classify_registration "$output")"
  else
    current=unknown
  fi
  if [[ "$current" == exact_custom ]]; then
    TARGET_MUTATED[i]=installed
    CLI_MUTATION_OCCURRED=true
    INSTALLED_TARGET_COMMANDS[i]="$(extract_command "$output")"
    INSTALLED_TARGET_ARGS[i]="$(extract_args "$output")"
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

registration_matches_expected() {
  local client="$1" name="$2" expected_class="$3" expected_command="$4" expected_args="$5" output actual_args
  output="$(client_get "$client" "$name" 2>&1)" || return 1
  actual_args="$(extract_args "$output")"
  [[ "$actual_args" != "-" ]] || actual_args=""
  [[ "$expected_args" != "-" ]] || expected_args=""
  registration_env_is_empty "$output" &&
    [[ "$(classify_registration "$output")" == "$expected_class" &&
       "$(extract_command "$output")" == "$expected_command" &&
       "$actual_args" == "$expected_args" ]]
}

require_expected_before_remove() {
  local client="$1" name="$2" expected_class="$3" expected_command="$4" expected_args="$5"
  if ! registration_matches_expected "$client" "$name" "$expected_class" "$expected_command" "$expected_args"; then
    echo "$client registration $name changed before removal; refusing delete." >&2
    return 1
  fi
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
        if ! require_expected_before_remove "$client" notebooklm-audio exact_custom \
             "${INSTALLED_TARGET_COMMANDS[$i]}" "${INSTALLED_TARGET_ARGS[$i]}"; then
          echo "Semantic rollback skipped changed $client notebooklm-audio." >&2
          failures=$((failures + 1))
        elif client_remove_raw "$client" notebooklm-audio; then
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
      require_expected_before_remove "$client" notebooklm-audio "$target_class" \
        "${TARGET_COMMANDS[$i]}" "${TARGET_ARGS[$i]}"
      remove_target_observed "$i" "$client"
    fi
    add_custom_observed "$i" "$client"
  fi

  output="$(client_get "$client" notebooklm-audio 2>&1)"
  [[ "$(classify_registration "$output")" == exact_custom ]] ||
    { echo "$client custom registration read-back did not match the launcher." >&2; exit 1; }
  INSTALLED_TARGET_COMMANDS[i]="$(extract_command "$output")"
  INSTALLED_TARGET_ARGS[i]="$(extract_args "$output")"

  # A known duplicate is removed only after the integrated custom registration
  # has been read back successfully.
  if [[ "$upstream_class" != absent ]]; then
    require_expected_before_remove "$client" notebooklm "$upstream_class" \
      "${UPSTREAM_COMMANDS[$i]}" "${UPSTREAM_ARGS[$i]}"
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
if ! release_client_locks; then
  echo "Installation changes were verified, but transaction lock release failed; refusing success." >&2
  exit 1
fi
echo "Installed and verified integrated MCP launcher: $ROOT_DIR/scripts/mcp-launcher.sh"
echo "Next: call setup_auth with show_browser=true using the same OS user."
