#!/usr/bin/env bash
# Isolated installer/bootstrap integration tests.  No real MCP config is read or
# written: every case uses a temporary HOME and fake Codex/Claude CLIs.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-installer-test.XXXXXX")"
TEST_ROOT="$(cd -- "$TEST_ROOT" && pwd -P)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
REAL_NODE="$(node -p 'process.execPath')"
REAL_GIT="$(command -v git)"
UPSTREAM_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

make_checkout() {
  local root="$1"
  mkdir -p "$root/scripts" "$root/dist" "$root/.git"
  cp "$SCRIPT_DIR/install.sh" "$root/scripts/install.sh"
  cp "$SCRIPT_DIR/bootstrap.sh" "$root/scripts/bootstrap.sh"
  cp "$SCRIPT_DIR/read-private-env.sh" "$root/scripts/read-private-env.sh"
  cp "$SCRIPT_DIR/mcp-launcher.sh" "$root/scripts/mcp-launcher.sh"
  cp "$SCRIPT_DIR/doctor.sh" "$root/scripts/doctor.sh"
  cp "$SCRIPT_DIR/../package.json" "$root/package.json"
  cp "$SCRIPT_DIR/../RELEASE_PROVENANCE.json" "$root/RELEASE_PROVENANCE.json"
  cp "$SCRIPT_DIR/../UPSTREAM_BASELINE.json" "$root/UPSTREAM_BASELINE.json"
  cp "$SCRIPT_DIR/../TRUSTED_RELEASES.json" "$root/TRUSTED_RELEASES.json"
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\nset -euo pipefail\nprintf "lineage verified\\n" >> "$FAKE_LOG"\n' > "$root/scripts/verify-upstream-lineage.sh"
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\nset -euo pipefail\nprintf "release verified\\n" >> "$FAKE_LOG"\n' > "$root/scripts/verify-install-release.sh"
  printf 'process.exit(0);\n' > "$root/scripts/verify-tool-compatibility.mjs"
  chmod +x "$root/scripts/"*.sh
  touch "$root/dist/index.js"
  chmod +x "$root/dist/index.js"
}

make_tools() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >> "$FAKE_LOG"
exit 0
EOF
  cat > "$bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "$FAKE_LOG"
while [[ "${1-}" == -c ]]; do shift 2; done
if [[ "${1-}" == -C ]]; then
  repo="$2"; shift 2
  case "${1-} ${2-} ${3-}" in
    "rev-parse HEAD "*) cat "$repo/.fake-head"; exit 0 ;;
  esac
fi
case "${1-}" in
  ls-remote)
    case "$*" in
      *refs/heads/main*) printf '%s\trefs/heads/main\n' "${FAKE_UPSTREAM_HEAD:?}" ;;
      *refs/tags/v0.0.1*) printf '%s\trefs/tags/v0.0.1\n' 17e818d040dcc9360d5658c7c7dc54a2e04893aa ;;
      *refs/tags/v0.0.2*) printf '%s\trefs/tags/v0.0.2\n' aa7d45935a236cd4824fb74a9890b556a17eb1b3 ;;
      *refs/tags/v2.0.0*) printf '%s\trefs/tags/v2.0.0\n' 50b3e7f67f8535d9899c5e2b1b68f37d17b72aef ;;
      *) exit 1 ;;
    esac
    ;;
  merge-base) [[ -z "${FAKE_MERGE_BASE_FAIL-}" ]] ;;
  cat-file|fetch) exit 0 ;;
  *) exit 0 ;;
esac
EOF
  cat > "$bin/fake-mcp-client" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
client="$(basename "$0")"
config_var="$(printf '%s_CONFIG_FILE' "$(printf '%s' "$client" | tr '[:lower:]' '[:upper:]')")"
eval "config=\${$config_var:?}"
state_dir="${FAKE_STATE_DIR:?}/$client"
mkdir -p "$state_dir" "$(dirname "$config")"
scope_args=()
[[ "$client" == claude ]] && scope_args=(--scope user)
[[ "${1-}" == mcp ]] || exit 2
op="${2-}"

config_remove_name() {
  local name="$1" temporary="$config.tmp"
  if [[ -f "$config" ]]; then
    grep -v "^mcp:$name:" "$config" > "$temporary" || true
  else
    : > "$temporary"
  fi
  mv -- "$temporary" "$config"
}

emit() {
  local name="$1" command args
  [[ -f "$state_dir/$name" ]] || exit 1
  command="$(sed -n '1p' "$state_dir/$name")"
  args="$(sed -n '2p' "$state_dir/$name")"
  if [[ "$client" == codex ]]; then
    printf '%s\n  command: %s\n  args: %s\n  env: -\n' "$name" "$command" "${args:--}"
  else
    printf '%s:\n  Command: %s\n  Args: %s\n  Environment:\n' "$name" "$command" "$args"
  fi
}

case "$op" in
  get)
    name="${3:?}"
    if [[ ! -f "$state_dir/$name" ]]; then
      if [[ "$client" == codex ]]; then
        printf "Error: No MCP server named '%s' found.\\n" "$name" >&2
      else
        printf 'No MCP server named "%s". Configured servers: none\n' "$name" >&2
      fi
      exit 1
    fi
    if [[ "${FAKE_CONCURRENT_ON_GET-}" == "$client:$name" && ! -e "$state_dir/.concurrent-get-$name" ]]; then
      touch "$state_dir/.concurrent-get-$name"
      printf 'concurrent-change\n' >> "$config"
      exit 1
    fi
    if [[ "${FAKE_FAIL_GET-}" == "$client:$name" && ! -e "$state_dir/.get-failed-$name" ]]; then
      touch "$state_dir/.get-failed-$name"
      exit 1
    fi
    emit "$name"
    ;;
  add)
    [[ "${FAKE_FAIL_ADD-}" != "$client" ]] || exit 1
    name=""
    command=""
    command_args=()
    argv=("$@")
    for ((arg_index = 0; arg_index < ${#argv[@]}; arg_index++)); do
      arg="${argv[$arg_index]}"
      [[ "$arg" == notebooklm-audio ]] && name="$arg"
      [[ "$arg" == notebooklm ]] && name="$arg"
      if [[ "$arg" == -- && $((arg_index + 1)) -lt ${#argv[@]} ]]; then
        command="${argv[$((arg_index + 1))]}"
        command_args=("${argv[@]:$((arg_index + 2))}")
        break
      fi
    done
    [[ -n "$name" && -n "$command" ]] || exit 2
    if [[ "${FAKE_NOOP_ADD-}" == "$client:$name" ]]; then exit 0; fi
    printf '%s\n%s\n' "$command" "${command_args[*]-}" > "$state_dir/$name"
    config_remove_name "$name"
    printf 'mcp:%s:%s\n' "$name" "$command" >> "$config"
    if [[ "${FAKE_CONCURRENT_DURING_ADD-}" == "$client" ]]; then
      printf 'concurrent-during-add\n' >> "$config"
    fi
    [[ "${FAKE_PARTIAL_ADD-}" != "$client" ]] || exit 1
    ;;
  remove)
    name=""
    for arg in "$@"; do
      [[ "$arg" == notebooklm || "$arg" == notebooklm-audio ]] && name="$arg"
    done
    [[ -n "$name" ]] || exit 2
    [[ "${FAKE_FAIL_REMOVE-}" != "$client:$name" ]] || exit 1
    rm -f -- "$state_dir/$name"
    config_remove_name "$name"
    [[ "${FAKE_PARTIAL_REMOVE-}" != "$client:$name" ]] || exit 1
    ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$bin/npm" "$bin/git" "$bin/fake-mcp-client"
  ln -s "$REAL_NODE" "$bin/node"
}

seed_registration() {
  local state="$1" client="$2" name="$3" command="$4" args="${5-}"
  mkdir -p "$state/$client"
  printf '%s\n%s\n' "$command" "$args" > "$state/$client/$name"
}

run_case() {
  local name="$1"
  CASE="$TEST_ROOT/$name"
  CHECKOUT="$CASE/custom checkout 日本語"
  HOME_DIR="$CASE/home"
  BIN="$CASE/bin"
  STATE="$CASE/state"
  LOG="$CASE/commands.log"
  mkdir -p "$HOME_DIR"
  make_checkout "$CHECKOUT"
  make_tools "$BIN"
  export FAKE_STATE_DIR="$STATE" FAKE_LOG="$LOG" FAKE_UPSTREAM_HEAD="$UPSTREAM_HEAD"
  export CODEX_CONFIG_FILE="$HOME_DIR/.codex/config.toml"
  export CLAUDE_CONFIG_FILE="$HOME_DIR/.claude.json"
  export HOME="$HOME_DIR"
  mkdir -p "$(dirname "$CODEX_CONFIG_FILE")" "$(dirname "$CLAUDE_CONFIG_FILE")"
  PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin"
  export PATH
  unset FAKE_FAIL_ADD FAKE_FAIL_GET FAKE_FAIL_REMOVE FAKE_CONCURRENT_ON_GET
  unset FAKE_CONCURRENT_DURING_ADD FAKE_PARTIAL_ADD FAKE_PARTIAL_REMOVE
  unset FAKE_NOOP_ADD FAKE_MERGE_BASE_FAIL
}

assert_build_contract() {
  local log="$1"
  grep -Fx 'release verified' "$log" >/dev/null
  grep -Fx 'npm ci --ignore-scripts' "$log" >/dev/null
  grep -Fx 'npm run build' "$log" >/dev/null
  grep -Fx 'npm run check' "$log" >/dev/null
  grep -Fx 'npm test' "$log" >/dev/null
  ! grep -E 'npx|@latest' "$log" >/dev/null
}

# Auto mode with neither client fails without touching an auth sentinel.
run_case neither
auth="$HOME_DIR/.local/share/notebooklm-mcp/browser_state/state.json"
mkdir -p "$(dirname "$auth")"; printf 'auth-sentinel' > "$auth"
auth_before="$(stat -f '%m:%z' "$auth" 2>/dev/null || stat -c '%Y:%s' "$auth")"
if "$CHECKOUT/scripts/bootstrap.sh" --auto >/dev/null 2>&1; then
  echo "auto mode accepted a host with neither client" >&2; exit 1
fi
[[ "$(stat -f '%m:%z' "$auth" 2>/dev/null || stat -c '%Y:%s' "$auth")" == "$auth_before" ]]
[[ "$(cat "$auth")" == auth-sentinel ]]

# Strict freshness fails before creating the default inbox.
run_case stale
ln -s fake-mcp-client "$BIN/codex"
export FAKE_MERGE_BASE_FAIL=1
if "$CHECKOUT/scripts/bootstrap.sh" --codex --require-upstream-current >/dev/null 2>&1; then
  echo "bootstrap accepted a stale upstream integration" >&2; exit 1
fi
[[ ! -e "$HOME_DIR/notebooklm-audio-inbox" ]]

# Codex-only auto install: known pinned upstream is removed after custom add.
run_case codex
ln -s fake-mcp-client "$BIN/codex"
seed_registration "$STATE" codex notebooklm npx '-y notebooklm-mcp@2.0.0'
auth="$HOME_DIR/.local/share/notebooklm-mcp/browser_state/state.json"
mkdir -p "$(dirname "$auth")"; printf 'auth-sentinel' > "$auth"
auth_before="$(stat -f '%m:%z' "$auth" 2>/dev/null || stat -c '%Y:%s' "$auth")"
"$CHECKOUT/scripts/bootstrap.sh" --auto >/dev/null
default_root="$HOME_DIR/notebooklm-audio-inbox"
[[ -d "$default_root" ]]
mode="$(stat -f '%Lp' "$default_root" 2>/dev/null || stat -c '%a' "$default_root")"
[[ "$mode" == 700 ]]
[[ -f "$STATE/codex/notebooklm-audio" && ! -e "$STATE/codex/notebooklm" ]]
[[ "$(cat "$auth")" == auth-sentinel ]]
[[ "$(stat -f '%m:%z' "$auth" 2>/dev/null || stat -c '%Y:%s' "$auth")" == "$auth_before" ]]
assert_build_contract "$LOG"

# Claude-only mode.
run_case claude
ln -s fake-mcp-client "$BIN/claude"
"$CHECKOUT/scripts/bootstrap.sh" --claude >/dev/null
[[ -f "$STATE/claude/notebooklm-audio" ]]

# Both clients, Unicode/space root, duplicate known upstream, and idempotency.
run_case both
ln -s fake-mcp-client "$BIN/codex"
ln -s fake-mcp-client "$BIN/claude"
audio_root="$CASE/audio inbox 日本語"
mkdir -p "$audio_root"
seed_registration "$STATE" codex notebooklm npx '-y notebooklm-mcp@2.0.0'
seed_registration "$STATE" claude notebooklm npx 'notebooklm-mcp@2.0.0'
"$CHECKOUT/scripts/bootstrap.sh" --all --audio-root "$audio_root" >/dev/null
codex_hash="$(shasum -a 256 "$CODEX_CONFIG_FILE" | awk '{print $1}')"
claude_hash="$(shasum -a 256 "$CLAUDE_CONFIG_FILE" | awk '{print $1}')"
env_hash="$(shasum -a 256 "$CHECKOUT/.audio-roots.env" | awk '{print $1}')"
"$CHECKOUT/scripts/bootstrap.sh" --all --audio-root "$audio_root" >/dev/null
[[ "$(shasum -a 256 "$CODEX_CONFIG_FILE" | awk '{print $1}')" == "$codex_hash" ]]
[[ "$(shasum -a 256 "$CLAUDE_CONFIG_FILE" | awk '{print $1}')" == "$claude_hash" ]]
[[ "$(shasum -a 256 "$CHECKOUT/.audio-roots.env" | awk '{print $1}')" == "$env_hash" ]]
grep -F "NOTEBOOKLM_AUDIO_ROOTS=$audio_root" "$CHECKOUT/.audio-roots.env" >/dev/null

# A provenance-verified previous custom checkout is replaceable.
run_case known_custom
ln -s fake-mcp-client "$BIN/codex"
old="$CASE/old custom"
mkdir -p "$old/scripts"
for old_file in package.json RELEASE_PROVENANCE.json scripts/mcp-launcher.sh; do
  "$REAL_GIT" -C "$PROJECT_ROOT" show "aa7d45935a236cd4824fb74a9890b556a17eb1b3:$old_file" > "$old/$old_file"
done
printf 'aa7d45935a236cd4824fb74a9890b556a17eb1b3\n' > "$old/.fake-head"
chmod +x "$old/scripts/mcp-launcher.sh"
seed_registration "$STATE" codex notebooklm-audio "$old/scripts/mcp-launcher.sh" ''
"$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null
grep -Fx "$CHECKOUT/scripts/mcp-launcher.sh" "$STATE/codex/notebooklm-audio" >/dev/null

# Self-asserted JSON without the canonical clean Git checkout is unknown.
run_case fake_custom
ln -s fake-mcp-client "$BIN/codex"
fake_custom="$CASE/fake custom"
mkdir -p "$fake_custom/scripts"
cp "$SCRIPT_DIR/../package.json" "$fake_custom/package.json"
cp "$SCRIPT_DIR/../RELEASE_PROVENANCE.json" "$fake_custom/RELEASE_PROVENANCE.json"
touch "$fake_custom/scripts/mcp-launcher.sh"; chmod +x "$fake_custom/scripts/mcp-launcher.sh"
seed_registration "$STATE" codex notebooklm-audio "$fake_custom/scripts/mcp-launcher.sh" ''
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer accepted self-asserted custom provenance" >&2; exit 1
fi
[[ -e "$STATE/codex/notebooklm-audio" ]]

# A canonical upstream checkout is a known removable duplicate.
run_case upstream_checkout
ln -s fake-mcp-client "$BIN/codex"
upstream_checkout="$CASE/upstream"
mkdir -p "$upstream_checkout/dist"
"$REAL_GIT" -C "$PROJECT_ROOT" archive 50b3e7f67f8535d9899c5e2b1b68f37d17b72aef | tar -x -C "$upstream_checkout"
ln -s "$PROJECT_ROOT/node_modules" "$upstream_checkout/node_modules"
"$PROJECT_ROOT/node_modules/.bin/tsc" -p "$upstream_checkout/tsconfig.json" >/dev/null 2>&1 || true
printf '50b3e7f67f8535d9899c5e2b1b68f37d17b72aef\n' > "$upstream_checkout/.fake-head"
chmod +x "$upstream_checkout/dist/index.js"
seed_registration "$STATE" codex notebooklm "$upstream_checkout/dist/index.js" ''
"$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null
[[ ! -e "$STATE/codex/notebooklm" ]]

# A program merely named npx is not the trusted literal npx registration.
run_case fake_npx
ln -s fake-mcp-client "$BIN/codex"
seed_registration "$STATE" codex notebooklm /tmp/npx '-y notebooklm-mcp@2.0.0'
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer accepted an arbitrary path ending in npx" >&2; exit 1
fi
[[ -e "$STATE/codex/notebooklm" ]]

# Unknown same-name registration fails closed before config/env mutation.
run_case unknown
ln -s fake-mcp-client "$BIN/codex"
printf 'original-config' > "$CODEX_CONFIG_FILE"
seed_registration "$STATE" codex notebooklm-audio /tmp/mystery-server ''
before="$(shasum -a 256 "$CODEX_CONFIG_FILE" | awk '{print $1}')"
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer replaced an unknown same-name registration" >&2; exit 1
fi
[[ "$(shasum -a 256 "$CODEX_CONFIG_FILE" | awk '{print $1}')" == "$before" ]]
[[ ! -e "$CHECKOUT/.audio-roots.env" ]]

# Modified upstream wrappers/arguments are unknown and never removed.
run_case modified
ln -s fake-mcp-client "$BIN/codex"
seed_registration "$STATE" codex notebooklm npx '-y notebooklm-mcp@2.0.0 --proxy'
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer accepted a modified upstream command" >&2; exit 1
fi
[[ -e "$STATE/codex/notebooklm" ]]

# Symlinked client configuration fails closed.
run_case symlink_config
ln -s fake-mcp-client "$BIN/codex"
printf 'real-config' > "$CASE/real-config"
ln -s "$CASE/real-config" "$CODEX_CONFIG_FILE"
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer accepted a symlinked client config" >&2; exit 1
fi
[[ "$(cat "$CASE/real-config")" == real-config ]]

# Add failure restores the private env and unchanged client config.
run_case add_failure
ln -s fake-mcp-client "$BIN/codex"
printf 'original-config' > "$CODEX_CONFIG_FILE"
printf 'old-env' > "$CHECKOUT/.audio-roots.env"; chmod 600 "$CHECKOUT/.audio-roots.env"
config_before="$(shasum -a 256 "$CODEX_CONFIG_FILE" | awk '{print $1}')"
env_before="$(shasum -a 256 "$CHECKOUT/.audio-roots.env" | awk '{print $1}')"
export FAKE_FAIL_ADD=codex
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored add failure" >&2; exit 1
fi
[[ "$(shasum -a 256 "$CODEX_CONFIG_FILE" | awk '{print $1}')" == "$config_before" ]]
[[ "$(shasum -a 256 "$CHECKOUT/.audio-roots.env" | awk '{print $1}')" == "$env_before" ]]

# Read-back failure restores a successful add.
run_case get_failure
ln -s fake-mcp-client "$BIN/codex"
printf 'original-config' > "$CODEX_CONFIG_FILE"
export FAKE_FAIL_GET=codex:notebooklm-audio
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored get failure" >&2; exit 1
fi
[[ "$(cat "$CODEX_CONFIG_FILE")" == original-config ]]

# A failure in the second client semantically rolls back the first client too.
run_case cross_client_failure
ln -s fake-mcp-client "$BIN/codex"
ln -s fake-mcp-client "$BIN/claude"
printf 'codex-original\n' > "$CODEX_CONFIG_FILE"
printf 'claude-original\n' > "$CLAUDE_CONFIG_FILE"
export FAKE_FAIL_ADD=claude
if "$CHECKOUT/scripts/install.sh" --all --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored second-client failure" >&2; exit 1
fi
[[ ! -e "$STATE/codex/notebooklm-audio" && ! -e "$STATE/claude/notebooklm-audio" ]]
[[ "$(cat "$CODEX_CONFIG_FILE")" == codex-original ]]
[[ "$(cat "$CLAUDE_CONFIG_FILE")" == claude-original ]]

# Removal failure after verified custom add rolls back successful prior writes.
run_case remove_failure
ln -s fake-mcp-client "$BIN/codex"
printf 'original-config' > "$CODEX_CONFIG_FILE"
seed_registration "$STATE" codex notebooklm npx '-y notebooklm-mcp@2.0.0'
export FAKE_FAIL_REMOVE=codex:notebooklm
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored remove failure" >&2; exit 1
fi
[[ "$(cat "$CODEX_CONFIG_FILE")" == original-config ]]

# Concurrent mutation during read-back is never overwritten by rollback.
run_case concurrent
ln -s fake-mcp-client "$BIN/codex"
printf 'original-config\n' > "$CODEX_CONFIG_FILE"
export FAKE_CONCURRENT_ON_GET=codex:notebooklm-audio
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored read-back failure" >&2; exit 1
fi
grep -F 'concurrent-change' "$CODEX_CONFIG_FILE" >/dev/null

# A concurrent edit inside a successful add is preserved by semantic rollback.
run_case concurrent_during_add
ln -s fake-mcp-client "$BIN/codex"
printf 'original-config\n' > "$CODEX_CONFIG_FILE"
seed_registration "$STATE" codex notebooklm npx '-y notebooklm-mcp@2.0.0'
export FAKE_CONCURRENT_DURING_ADD=codex
export FAKE_FAIL_REMOVE=codex:notebooklm
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored post-add failure" >&2; exit 1
fi
grep -F 'concurrent-during-add' "$CODEX_CONFIG_FILE" >/dev/null
[[ ! -e "$STATE/codex/notebooklm-audio" ]]

# A CLI that writes the custom registration and then exits nonzero is observed
# and semantically rolled back.
run_case partial_add
ln -s fake-mcp-client "$BIN/codex"
printf 'original-config\n' > "$CODEX_CONFIG_FILE"
export FAKE_PARTIAL_ADD=codex
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored a partial-success add" >&2; exit 1
fi
[[ ! -e "$STATE/codex/notebooklm-audio" ]]
[[ "$(cat "$CODEX_CONFIG_FILE")" == original-config ]]

# A CLI that removes upstream and then exits nonzero is observed and restored.
run_case partial_remove
ln -s fake-mcp-client "$BIN/codex"
seed_registration "$STATE" codex notebooklm-audio "$CHECKOUT/scripts/mcp-launcher.sh" ''
seed_registration "$STATE" codex notebooklm npx '-y notebooklm-mcp@2.0.0'
export FAKE_PARTIAL_REMOVE=codex:notebooklm
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >/dev/null 2>&1; then
  echo "installer ignored a partial-success remove" >&2; exit 1
fi
[[ -e "$STATE/codex/notebooklm" ]]

# Rollback add exit-zero without the expected state must fail read-back.
run_case rollback_readback
ln -s fake-mcp-client "$BIN/codex"
seed_registration "$STATE" codex notebooklm-audio "$CHECKOUT/scripts/mcp-launcher.sh" ''
seed_registration "$STATE" codex notebooklm npx '-y notebooklm-mcp@2.0.0'
export FAKE_PARTIAL_REMOVE=codex:notebooklm
export FAKE_NOOP_ADD=codex:notebooklm
rollback_log="$CASE/rollback.log"
if "$CHECKOUT/scripts/install.sh" --codex --audio-root "$CASE" >"$rollback_log" 2>&1; then
  echo "installer accepted a rollback add with no state change" >&2; exit 1
fi
grep -E 'rollback (failed|read-back)' "$rollback_log" >/dev/null

echo "installer/bootstrap isolated failure matrix: PASS"
