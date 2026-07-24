#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
[[ -f DIST_MANIFEST.sha256 ]] || { echo "Missing manifest; run generate-manifest.sh" >&2; exit 1; }
if command -v shasum >/dev/null; then shasum -a 256 -c DIST_MANIFEST.sha256; else sha256sum -c DIST_MANIFEST.sha256; fi
