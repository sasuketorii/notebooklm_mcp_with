#!/usr/bin/env bash
# One-prompt bootstrap for Codex, Claude Code, or both.
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
MODE=auto
REQUIRE_UPSTREAM_CURRENT=false
AUDIO_ROOTS=()

usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap.sh [--auto|--codex|--claude|--all]
                              [--audio-root PATH ...]
                              [--require-upstream-current]

Auto detects installed MCP clients by default.  With no --audio-root, creates a
private per-user inbox (mode 0700).  Reviewed local lineage is always required;
--require-upstream-current additionally checks that live upstream main is
already integrated.  Bootstrap never merges upstream or installs a second MCP.
EOF
}

while (( $# )); do
  arg="$1"; shift
  case "$arg" in
    --auto) MODE=auto ;;
    --codex) MODE=codex ;;
    --claude) MODE=claude ;;
    --all) MODE=all ;;
    --require-upstream-current) REQUIRE_UPSTREAM_CURRENT=true ;;
    --audio-root)
      (( $# )) || { echo "--audio-root requires PATH" >&2; exit 2; }
      AUDIO_ROOTS+=("$1"); shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  { echo "Bootstrap requires a Git checkout so upstream lineage can be verified." >&2; exit 1; }
"$ROOT_DIR/scripts/verify-install-release.sh"
"$ROOT_DIR/scripts/verify-upstream-lineage.sh"

if "$REQUIRE_UPSTREAM_CURRENT"; then
  UPSTREAM_URL="https://github.com/PleasePrompto/notebooklm-mcp.git"
  upstream_line="$(git ls-remote "$UPSTREAM_URL" refs/heads/main)"
  [[ "$upstream_line" != *$'\n'* ]] ||
    { echo "Upstream main resolved to multiple refs." >&2; exit 1; }
  upstream_head="${upstream_line%%[[:space:]]*}"
  [[ "$upstream_head" =~ ^[0-9a-f]{40}$ ]] ||
    { echo "Could not resolve the exact upstream main commit." >&2; exit 1; }
  if ! git cat-file -e "$upstream_head^{commit}" 2>/dev/null; then
    git fetch --no-tags "$UPSTREAM_URL" "$upstream_head"
  fi
  git merge-base --is-ancestor "$upstream_head" HEAD ||
    {
      echo "This custom checkout is behind upstream main ($upstream_head)." >&2
      echo "A maintainer must integrate upstream and pass the custom regression suite before installation." >&2
      exit 1
    }
  echo "Verified current upstream main is integrated: $upstream_head"
fi

case "$MODE" in
  auto)
    have_codex=false
    have_claude=false
    command -v codex >/dev/null && have_codex=true
    command -v claude >/dev/null && have_claude=true
    if "$have_codex" && "$have_claude"; then MODE=all
    elif "$have_codex"; then MODE=codex
    elif "$have_claude"; then MODE=claude
    else
      echo "Neither Codex nor Claude Code CLI was found." >&2
      exit 1
    fi
    ;;
  codex) command -v codex >/dev/null || { echo "Codex CLI was not found." >&2; exit 1; } ;;
  claude) command -v claude >/dev/null || { echo "Claude Code CLI was not found." >&2; exit 1; } ;;
  all)
    command -v codex >/dev/null || { echo "Codex CLI was not found." >&2; exit 1; }
    command -v claude >/dev/null || { echo "Claude Code CLI was not found." >&2; exit 1; }
    ;;
esac

if (( ${#AUDIO_ROOTS[@]} == 0 )); then
  default_root="$HOME/notebooklm-audio-inbox"
  [[ ! -L "$default_root" ]] ||
    { echo "Default audio root must not be a symbolic link: $default_root" >&2; exit 1; }
  if [[ ! -e "$default_root" ]]; then
    mkdir -m 700 -- "$default_root"
  fi
  [[ ! -L "$default_root" && -d "$default_root" ]] ||
    { echo "Default audio root must be a regular directory: $default_root" >&2; exit 1; }
  if [[ "$(uname -s)" == Darwin ]]; then
    root_identity="$(stat -f '%d:%i' "$default_root")"
    root_owner="$(stat -f '%u' "$default_root")"
    root_mode="$(stat -f '%Lp' "$default_root")"
  else
    root_identity="$(stat -c '%d:%i' "$default_root")"
    root_owner="$(stat -c '%u' "$default_root")"
    root_mode="$(stat -c '%a' "$default_root")"
  fi
  [[ "$root_owner" == "$(id -u)" && "$root_mode" == 700 ]] ||
    { echo "Default audio root must be owned by the current user with mode 0700." >&2; exit 1; }
  [[ "$(cd -- "$default_root" && pwd -P)" == "$default_root" ]] ||
    { echo "Default audio root path must already be canonical." >&2; exit 1; }
  if [[ "$(uname -s)" == Darwin ]]; then
    root_identity_after="$(stat -f '%d:%i' "$default_root")"
  else
    root_identity_after="$(stat -c '%d:%i' "$default_root")"
  fi
  [[ ! -L "$default_root" && "$root_identity_after" == "$root_identity" ]] ||
    { echo "Default audio root changed during validation." >&2; exit 1; }
  AUDIO_ROOTS+=("$default_root")
fi

install_args=("--$MODE")
for root in "${AUDIO_ROOTS[@]}"; do
  install_args+=(--audio-root "$root")
done
"$ROOT_DIR/scripts/install.sh" "${install_args[@]}"
node "$ROOT_DIR/scripts/verify-tool-compatibility.mjs"
"$ROOT_DIR/scripts/doctor.sh"
