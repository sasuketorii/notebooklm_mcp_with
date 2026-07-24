#!/usr/bin/env bash
# Build this local fork and optionally register its launcher with local MCP clients.
# No command in this script ever registers the upstream npm package.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
REGISTER_CODEX=false
REGISTER_CLAUDE=false
AUDIO_ROOTS=()

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [--codex] [--claude] [--all] [--audio-root PATH ...]

Builds the local fork with npm ci. Registration is opt-in and uses this
checkout's scripts/mcp-launcher.sh (never `npx notebooklm-mcp@latest`).

Before changing a Codex/Claude registration, this script verifies every
requested CLI and makes rollback copies of their user configuration. If a
remove, add, or read-back check fails, the original registrations are restored.
EOF
}

while (( $# )); do
  arg="$1"; shift
  case "$arg" in
    --codex) REGISTER_CODEX=true ;;
    --claude) REGISTER_CLAUDE=true ;;
    --all) REGISTER_CODEX=true; REGISTER_CLAUDE=true ;;
    --audio-root) (( $# )) || { echo "--audio-root requires PATH" >&2; exit 2; }; AUDIO_ROOTS+=("$1"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js 22.13+ is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
NODE_COMMAND="$(command -v node)"
NODE_BIN="$(cd -- "$(dirname -- "$NODE_COMMAND")" && pwd -P)/$(basename -- "$NODE_COMMAND")"
"$NODE_BIN" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)' || { echo "Node.js 22.13+ is required; found $("$NODE_BIN" --version)." >&2; exit 1; }

cd "$ROOT_DIR"

if "$REGISTER_CODEX" || "$REGISTER_CLAUDE"; then
  # Preflight *all* registrations before touching either client configuration.
  if "$REGISTER_CODEX"; then
    command -v codex >/dev/null || { echo "Codex CLI was not found." >&2; exit 1; }
  fi
  if "$REGISTER_CLAUDE"; then
    command -v claude >/dev/null || { echo "Claude Code CLI was not found." >&2; exit 1; }
  fi
  (( ${#AUDIO_ROOTS[@]} )) || { echo "Registration requires one or more --audio-root PATH values." >&2; exit 2; }
  canonical_roots=()
  for root in "${AUDIO_ROOTS[@]}"; do
    [[ -d "$root" ]] || { echo "Audio root is not a directory: $root" >&2; exit 2; }
    canonical="$(cd -- "$root" && pwd -P)"
    [[ "$canonical" != *:* ]] || { echo "Audio root cannot contain a colon: $canonical" >&2; exit 2; }
    canonical_roots+=("$canonical")
  done
  roots_value="$(IFS=:; printf '%s' "${canonical_roots[*]}")"
fi

npm ci
npm run check

# Neither CLI exposes an atomic "replace this stdio command" operation. Preserve
# the complete user-level configuration before remove/add, then restore it if any
# registration or its required read-back verification fails.
ROLLBACK_DIR=""
ROLLBACK_NEEDED=false
CODEX_CONFIG_FILE="${CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"
CLAUDE_CONFIG_FILE="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"
declare -a BACKUP_FILES=()
declare -a BACKUP_EXISTED=()

backup_config() {
  local file="$1" index="${#BACKUP_FILES[@]}"
  BACKUP_FILES+=("$file")
  if [[ -e "$file" ]]; then
    BACKUP_EXISTED+=(true)
    cp -p -- "$file" "$ROLLBACK_DIR/$index"
  else
    BACKUP_EXISTED+=(false)
  fi
}

restore_configs() {
  local index file
  for ((index = 0; index < ${#BACKUP_FILES[@]}; index++)); do
    file="${BACKUP_FILES[$index]}"
    if [[ "${BACKUP_EXISTED[$index]}" == true ]]; then
      mkdir -p -- "$(dirname -- "$file")"
      cp -p -- "$ROLLBACK_DIR/$index" "$file"
    else
      rm -f -- "$file"
    fi
  done
}

cleanup_registration() {
  local status="$?"
  if "$ROLLBACK_NEEDED"; then
    echo "Registration failed; restoring the previous MCP configuration." >&2
    restore_configs || echo "Automatic rollback failed; copies remain in $ROLLBACK_DIR" >&2
    return "$status"
  fi
  [[ -z "$ROLLBACK_DIR" ]] || rm -rf -- "$ROLLBACK_DIR"
}

if "$REGISTER_CODEX" || "$REGISTER_CLAUDE"; then
  ROLLBACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-mcp-audio.XXXXXX")"
  trap cleanup_registration EXIT
  "$REGISTER_CODEX" && backup_config "$CODEX_CONFIG_FILE"
  "$REGISTER_CLAUDE" && backup_config "$CLAUDE_CONFIG_FILE"
  # The launcher reads this file on every start, so it participates in the same
  # transaction as the client registrations.
  backup_config "$ROOT_DIR/.audio-roots.env"
  ROLLBACK_NEEDED=true

  umask 077
  existing_http_token=""
  if [[ -f "$ROOT_DIR/.audio-roots.env" ]]; then
    # shellcheck disable=SC1090
    source "$ROOT_DIR/.audio-roots.env"
    existing_http_token="${NOTEBOOKLM_HTTP_BEARER_TOKEN:-}"
  fi
  if [[ ${#existing_http_token} -lt 32 ]]; then
    existing_http_token="$($NODE_BIN -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  fi
  env_temp="$(mktemp "$ROOT_DIR/.audio-roots.env.XXXXXX")"
  { printf 'NOTEBOOKLM_NODE_BIN=%q\n' "$NODE_BIN"; printf 'NOTEBOOKLM_AUDIO_ROOTS=%q\n' "$roots_value"; printf 'NOTEBOOKLM_HTTP_BEARER_TOKEN=%q\n' "$existing_http_token"; } > "$env_temp"
  chmod 600 "$env_temp"
  mv -f -- "$env_temp" "$ROOT_DIR/.audio-roots.env"

  if "$REGISTER_CODEX"; then
    codex mcp remove notebooklm-audio >/dev/null 2>&1 || true
    codex mcp add notebooklm-audio -- "$ROOT_DIR/scripts/mcp-launcher.sh"
    codex mcp get notebooklm-audio >/dev/null
  fi
  if "$REGISTER_CLAUDE"; then
    claude mcp remove --scope user notebooklm-audio >/dev/null 2>&1 || true
    claude mcp add --scope user notebooklm-audio -- "$ROOT_DIR/scripts/mcp-launcher.sh"
    claude mcp get notebooklm-audio >/dev/null
  fi
  ROLLBACK_NEEDED=false
fi

echo "Installed local build; MCP launcher: $ROOT_DIR/scripts/mcp-launcher.sh"
echo "Next: call setup_auth with show_browser=true using the same OS user that will run the MCP server."
