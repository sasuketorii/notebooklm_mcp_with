#!/usr/bin/env bash
# Generates a portable release manifest without auth profiles, secrets, dependencies, or caches.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTPUT="$ROOT_DIR/DIST_MANIFEST.sha256"
cd "$ROOT_DIR"

files=(package.json package-lock.json README.md SETUP_JA.md RELEASE_PROVENANCE.json LICENSE tsconfig.json eslint.config.js .prettierrc.json .prettierignore .gitignore CHANGELOG.md)
while IFS= read -r -d '' file; do files+=("$file"); done < <(find src docs scripts -type f -print0 | sort -z)

if command -v shasum >/dev/null; then
  shasum -a 256 "${files[@]}" > "$OUTPUT"
else
  sha256sum "${files[@]}" > "$OUTPUT"
fi
echo "Wrote $OUTPUT"
