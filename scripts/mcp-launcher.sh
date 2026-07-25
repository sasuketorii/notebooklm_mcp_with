#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$ROOT_DIR/.audio-roots.env"
# shellcheck disable=SC1090
source "$ROOT_DIR/scripts/read-private-env.sh"
private_env_load "$ENV_FILE"
export NOTEBOOKLM_NODE_BIN NOTEBOOKLM_AUDIO_ROOTS
exec "$NOTEBOOKLM_NODE_BIN" "$ROOT_DIR/dist/index.js"
