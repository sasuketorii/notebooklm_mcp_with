#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=release-files.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/release-files.sh"

ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
MANIFEST=""
ROOT_SEEN=0
MANIFEST_SEEN=0
while (($#)); do
  case "$1" in
    --root)
      (($# >= 2)) || { echo "--root requires a directory" >&2; exit 2; }
      ((ROOT_SEEN == 0)) || { echo "--root may be specified only once" >&2; exit 2; }
      ROOT_SEEN=1
      ROOT_DIR="$2"
      shift 2
      ;;
    --manifest)
      (($# >= 2)) || { echo "--manifest requires a file" >&2; exit 2; }
      ((MANIFEST_SEEN == 0)) || { echo "--manifest may be specified only once" >&2; exit 2; }
      MANIFEST_SEEN=1
      MANIFEST="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--root DIR] [--manifest FILE]" >&2
      exit 2
      ;;
  esac
done

release_validate_root "$ROOT_DIR"
ROOT_DIR="$(cd -- "$ROOT_DIR" && pwd -P)"
MANIFEST="${MANIFEST:-"$ROOT_DIR/DIST_MANIFEST.sha256"}"
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || {
  echo "Manifest must be a regular file, not a symlink: $MANIFEST" >&2
  exit 1
}

FILE_LIST="$(mktemp "${TMPDIR:-/tmp}/notebooklm-release-files.XXXXXX")"
trap '/bin/rm -f -- "$FILE_LIST"' EXIT
release_collect_files "$ROOT_DIR" "$FILE_LIST"

python3 - "$ROOT_DIR" "$MANIFEST" "$FILE_LIST" <<'PY'
import hashlib
import os
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
manifest = Path(sys.argv[2])
expected = set(Path(sys.argv[3]).read_bytes().split(b"\0"))
expected.discard(b"")
entries: dict[bytes, str] = {}

for line_number, raw in enumerate(manifest.read_bytes().splitlines(), 1):
    match = re.fullmatch(rb"([0-9a-f]{64})  (.+)", raw)
    if not match:
        raise SystemExit(f"Malformed manifest line {line_number}")
    digest = match.group(1).decode("ascii")
    relative = match.group(2)
    if (
        relative.startswith(b"/")
        or b"\\" in relative
        or b"\r" in relative
        or b"\n" in relative
        or any(part in (b"", b".", b"..") for part in relative.split(b"/"))
    ):
        raise SystemExit(f"Unsafe manifest path on line {line_number}")
    if relative in entries:
        raise SystemExit(f"Duplicate manifest path on line {line_number}")
    entries[relative] = digest

actual = set(entries)
if actual != expected:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    raise SystemExit(f"Manifest file set mismatch: missing={missing[:3]!r}, extra={extra[:3]!r}")

for relative, expected_digest in entries.items():
    path = root.joinpath(os.fsdecode(relative))
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"Manifest path is not a regular file: {os.fsdecode(relative)}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_digest:
        raise SystemExit(f"Manifest checksum mismatch: {os.fsdecode(relative)}")
PY

echo "Manifest verified: $MANIFEST"
