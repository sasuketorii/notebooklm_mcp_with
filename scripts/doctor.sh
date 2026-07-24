#!/usr/bin/env bash
# Read-only local readiness checks. It never displays or copies auth material.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
failures=0

check_command() {
  if command -v "$1" >/dev/null; then
    echo "OK    $1: $(command -v "$1")"
  else
    echo "MISS  $1" >&2
    failures=$((failures + 1))
  fi
}

check_command node
check_command npm
if command -v node >/dev/null; then
  if node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)'; then echo "OK    Node.js $(node --version)"; else echo "FAIL  Node.js 22.13+ required" >&2; failures=$((failures + 1)); fi
fi

ENV_FILE="$ROOT_DIR/.audio-roots.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  if [[ -x "${NOTEBOOKLM_NODE_BIN:-}" ]]; then
    if "$NOTEBOOKLM_NODE_BIN" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)'; then
      echo "OK    launcher Node: $NOTEBOOKLM_NODE_BIN"
    else
      echo "FAIL  launcher Node is older than 22.13" >&2; failures=$((failures + 1))
    fi
  else
    echo "FAIL  configured launcher Node is missing" >&2; failures=$((failures + 1))
  fi
  [[ -n "${NOTEBOOKLM_AUDIO_ROOTS:-}" ]] || { echo "FAIL  no configured audio roots" >&2; failures=$((failures + 1)); }
else
  echo "INFO  no launcher environment; registration has not been configured"
fi

if [[ -x "$ROOT_DIR/dist/index.js" ]]; then
  echo "OK    build: dist/index.js"
else
  echo "MISS  build: run ./scripts/install.sh" >&2
  failures=$((failures + 1))
fi

case "$(uname -s)" in
  Darwin) DATA_DIR="$HOME/Library/Application Support/notebooklm-mcp" ;;
  Linux) DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/notebooklm-mcp" ;;
  *) DATA_DIR="(platform-specific env-paths directory)" ;;
esac
permission_mode() {
  if [[ "$(uname -s)" == "Darwin" ]]; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}
for sensitive_dir in "$DATA_DIR" "$DATA_DIR/browser_state" "$DATA_DIR/chrome_profile" "$DATA_DIR/chrome_profile_instances"; do
  if [[ -d "$sensitive_dir" ]]; then
    mode="$(permission_mode "$sensitive_dir")"
    if [[ "$mode" == "700" ]]; then echo "OK    private directory permissions: $sensitive_dir"; else echo "FAIL  $sensitive_dir mode is $mode (expected 700)" >&2; failures=$((failures + 1)); fi
  fi
done
for sensitive_file in "$DATA_DIR/browser_state/state.json" "$DATA_DIR/browser_state/session.json"; do
  if [[ -f "$sensitive_file" ]]; then
    mode="$(permission_mode "$sensitive_file")"
    if [[ "$mode" == "600" ]]; then echo "OK    private auth file permissions: $(basename "$sensitive_file")"; else echo "FAIL  auth file $(basename "$sensitive_file") mode is $mode (expected 600)" >&2; failures=$((failures + 1)); fi
  fi
done
if [[ -d "$DATA_DIR/chrome_profile" ]]; then
  echo "OK    browser profile exists (contents intentionally not inspected)"
else
  echo "INFO  no browser profile found; run setup_auth with show_browser=true"
fi

if command -v google-chrome >/dev/null || command -v chromium >/dev/null || command -v chromium-browser >/dev/null; then
  echo "OK    Chrome/Chromium command found"
else
  echo "INFO  Chrome/Chromium command not found; Patchright fallback may be used"
fi

(( failures == 0 )) || exit 1
