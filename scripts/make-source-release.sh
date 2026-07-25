#!/usr/bin/env bash
# Build an audit-only source archive. Authentication, audio, dependencies,
# build output and .git are excluded; use a Git checkout to follow upstream.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTPUT="${1:-$(dirname -- "$ROOT_DIR")/notebooklm-mcp-audio-custom-source.tar.gz}"
cd "$ROOT_DIR"

./scripts/generate-manifest.sh
./scripts/verify-manifest.sh

files=(AGENTS.md CLAUDE.md CUSTOM_TOOL_CONTRACTS.json TRUSTED_RELEASES.json UPSTREAM_BASELINE.json package.json package-lock.json README.md SETUP_JA.md RELEASE_PROVENANCE.json LICENSE tsconfig.json eslint.config.js .prettierrc.json .prettierignore .gitignore CHANGELOG.md DIST_MANIFEST.sha256 .github src docs scripts)
ARCHIVE_ROOT="notebooklm-mcp-audio-custom"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-mcp-audio-release.XXXXXX")"
trap 'rm -rf -- "$STAGE_DIR"' EXIT
mkdir -p "$STAGE_DIR/$ARCHIVE_ROOT"
cp -R "${files[@]}" "$STAGE_DIR/$ARCHIVE_ROOT/"
# Disable macOS Finder metadata so BSD tar never emits AppleDouble (._*) files.
# Explicitly normalize both numeric and textual ownership while accounting for
# the different option sets exposed by BSD/libarchive tar and GNU tar.
tar_version="$(tar --version 2>&1 | head -n 1)"
case "$tar_version" in
  *GNU\ tar*)
    # GNU tar accepts NAME:ID and records both stable names and IDs.
    tar_owner_args=(--owner=root:0 --group=root:0)
    ;;
  *bsdtar*|*libarchive*)
    tar_owner_args=(--uid=0 --gid=0 --uname=root --gname=root)
    ;;
  *)
    echo "Unsupported tar implementation: $tar_version" >&2
    exit 1
    ;;
esac
COPYFILE_DISABLE=1 tar -C "$STAGE_DIR" -czf "$OUTPUT" \
  "${tar_owner_args[@]}" "$ARCHIVE_ROOT"

# Fail closed if a future script change causes extraction to scatter files.
if ! tar -tzf "$OUTPUT" | awk -v prefix="$ARCHIVE_ROOT/" 'index($0, prefix) != 1 { exit 1 }'; then
  echo "Archive layout check failed: every entry must be under $ARCHIVE_ROOT/" >&2
  exit 1
fi

# Keep the audit artifact portable and install-independent. Reject metadata and any
# authentication, generated, dependency, or build-output paths fail-closed.
if ! tar -tzf "$OUTPUT" | awk '
  {
    path = $0
    n = split(path, parts, "/")
    base = parts[n]
    if (base ~ /^\._/ || base == ".DS_Store" || base == ".audio-roots.env" ||
        base == "state.json" || base == "session.json" || base ~ /^chrome_profile/ ||
        base ~ /^browser_state/ || base ~ /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/) exit 1
    for (i = 1; i <= n; i++) {
      if (parts[i] == "node_modules" || parts[i] == "dist" || parts[i] == ".git") exit 1
    }
  }
'; then
  echo "Archive content check failed: metadata or forbidden paths found" >&2
  exit 1
fi
echo "Wrote source-only archive: $OUTPUT"
