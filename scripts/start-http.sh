#!/usr/bin/env bash
# Start Streamable HTTP on loopback. Put a TLS/authenticated reverse proxy or
# Tailscale tunnel in front when remote access is required.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
HOST="${NOTEBOOKLM_HOST:-127.0.0.1}"
PORT="${NOTEBOOKLM_PORT:-3000}"

[[ -x "$ROOT_DIR/dist/index.js" ]] || { echo "Build missing. Run ./scripts/install.sh first." >&2; exit 1; }
ENV_FILE="$ROOT_DIR/.audio-roots.env"
[[ -f "$ENV_FILE" ]] || { echo "Missing .audio-roots.env; rerun install.sh with --audio-root." >&2; exit 1; }
# Preserve a non-empty caller-provided token before sourcing the private env
# file; ambient credentials intentionally take precedence over file defaults.
AMBIENT_HTTP_BEARER_TOKEN="${NOTEBOOKLM_HTTP_BEARER_TOKEN-}"
# shellcheck disable=SC1090
source "$ENV_FILE"
if [[ -n "$AMBIENT_HTTP_BEARER_TOKEN" ]]; then
  NOTEBOOKLM_HTTP_BEARER_TOKEN="$AMBIENT_HTTP_BEARER_TOKEN"
fi
[[ -x "${NOTEBOOKLM_NODE_BIN:-}" ]] || { echo "Configured Node binary is missing; rerun install.sh." >&2; exit 1; }
[[ -n "${NOTEBOOKLM_AUDIO_ROOTS:-}" ]] || { echo "No audio roots configured; rerun install.sh." >&2; exit 1; }
HTTP_BEARER_TOKEN="${NOTEBOOKLM_HTTP_BEARER_TOKEN-}"
[[ ${#HTTP_BEARER_TOKEN} -ge 32 ]] || { echo "NOTEBOOKLM_HTTP_BEARER_TOKEN must be at least 32 bytes; rerun install.sh." >&2; exit 1; }
# Values loaded from a shell file are not automatically inherited by exec'd
# processes. Export the generated launcher contract to the HTTP server too.
export NOTEBOOKLM_NODE_BIN NOTEBOOKLM_AUDIO_ROOTS NOTEBOOKLM_HTTP_BEARER_TOKEN="$HTTP_BEARER_TOKEN"
if [[ "$HOST" != "127.0.0.1" && "$HOST" != "::1" && "$HOST" != "localhost" ]]; then
  echo "Refusing non-loopback cleartext HTTP bind. Use a TLS-terminating reverse proxy or Tailscale tunnel." >&2
  exit 1
fi
exec "$NOTEBOOKLM_NODE_BIN" "$ROOT_DIR/dist/index.js" --transport http --host "$HOST" --port "$PORT"
