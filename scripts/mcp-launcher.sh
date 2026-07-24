#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$ROOT_DIR/.audio-roots.env"
[[ -f "$ENV_FILE" ]] || { echo "Missing .audio-roots.env; rerun install.sh with --audio-root." >&2; exit 1; }
# This file is generated with shell-escaped values by install.sh; do not hand-edit
# it or replace it with a generic dotenv parser.
# shellcheck disable=SC1090
source "$ENV_FILE"
[[ -n "${NOTEBOOKLM_NODE_BIN:-}" && -x "$NOTEBOOKLM_NODE_BIN" ]] || { echo "Configured Node binary is missing; rerun install.sh." >&2; exit 1; }
[[ -n "${NOTEBOOKLM_AUDIO_ROOTS:-}" ]] || { echo "No audio roots configured; rerun install.sh." >&2; exit 1; }
# Values loaded from a shell file are not automatically inherited by exec'd
# processes. Export exactly the two generated values, not the caller's env.
export NOTEBOOKLM_NODE_BIN NOTEBOOKLM_AUDIO_ROOTS
exec "$NOTEBOOKLM_NODE_BIN" "$ROOT_DIR/dist/index.js"
