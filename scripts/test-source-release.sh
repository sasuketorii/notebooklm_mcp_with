#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTPUT="$(mktemp "${TMPDIR:-/tmp}/notebooklm-mcp-source-test.XXXXXX.tar.gz")"
trap 'rm -f -- "$OUTPUT"' EXIT

"$ROOT_DIR/scripts/make-source-release.sh" "$OUTPUT" >/dev/null
python3 - "$OUTPUT" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], mode="r:gz") as archive:
    bad = [
        (member.name, member.uid, member.gid, member.uname, member.gname)
        for member in archive.getmembers()
        if member.uid != 0 or member.gid != 0 or member.uname != "root" or member.gname != "root"
    ]
if bad:
    raise SystemExit(f"Archive ownership check failed: {bad[:3]}")
PY
tar -tzf "$OUTPUT" | awk '
  {
    n = split($0, parts, "/")
    base = parts[n]
    if (base ~ /^\._/ || base == ".DS_Store" || base == ".audio-roots.env" ||
        base == "state.json" || base == "session.json" || base ~ /^chrome_profile/ ||
        base ~ /^browser_state/ || base ~ /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/) exit 1
    for (i = 1; i <= n; i++) {
      if (parts[i] == "node_modules" || parts[i] == "dist" || parts[i] == ".git") exit 1
    }
  }
'
echo "Source release archive is clean"
