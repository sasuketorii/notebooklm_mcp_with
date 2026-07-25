#!/usr/bin/env bash
# Build an audit-only source archive without modifying the repository.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=release-files.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/release-files.sh"

(($# <= 1)) || {
  echo "Usage: $0 [OUTPUT.tar.gz]" >&2
  exit 2
}
OUTPUT="${1:-$(dirname -- "$ROOT_DIR")/notebooklm-mcp-audio-custom-source.tar.gz}"
[[ -n "$OUTPUT" && ! -d "$OUTPUT" && ! -L "$OUTPUT" ]] || {
  echo "Archive output must be a regular file path, not a directory or symlink: $OUTPUT" >&2
  exit 1
}
if [[ -e "$OUTPUT" && ! -f "$OUTPUT" ]]; then
  echo "Archive output must be a regular file path: $OUTPUT" >&2
  exit 1
fi
OUTPUT_DIR="$(dirname -- "$OUTPUT")"
OUTPUT_BASE="$(basename -- "$OUTPUT")"
[[ "$OUTPUT_BASE" != "." && "$OUTPUT_BASE" != ".." &&
   "$OUTPUT_BASE" != *$'\n'* && "$OUTPUT_BASE" != *$'\r'* ]] || {
  echo "Unsafe archive output path: $OUTPUT" >&2
  exit 1
}
[[ -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] || {
  echo "Archive output parent must be a real directory: $OUTPUT_DIR" >&2
  exit 1
}
OUTPUT_DIR="$(cd -- "$OUTPUT_DIR" && pwd -P)"
OUTPUT="$OUTPUT_DIR/$OUTPUT_BASE"
case "$OUTPUT" in
  "$ROOT_DIR"|"$ROOT_DIR"/*)
    echo "Archive output must be outside the source repository: $OUTPUT" >&2
    exit 1
    ;;
esac

ARCHIVE_ROOT="notebooklm-mcp-audio-custom"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-mcp-audio-release.XXXXXX")"
FILE_LIST="$(mktemp "${TMPDIR:-/tmp}/notebooklm-release-files.XXXXXX")"
TEMP_ARCHIVE="$(mktemp "$OUTPUT_DIR/.${OUTPUT_BASE}.tmp.XXXXXX")"
trap '/bin/rm -rf -- "$STAGE_DIR"; /bin/rm -f -- "$FILE_LIST" "$TEMP_ARCHIVE"' EXIT
STAGE_ROOT="$STAGE_DIR/$ARCHIVE_ROOT"
mkdir -p "$STAGE_ROOT"

release_collect_files "$ROOT_DIR" "$FILE_LIST"
while IFS= read -r -d '' relative; do
  mkdir -p -- "$STAGE_ROOT/$(dirname -- "$relative")"
  cp -pP -- "$ROOT_DIR/$relative" "$STAGE_ROOT/$relative"
done <"$FILE_LIST"

"$STAGE_ROOT/scripts/generate-manifest.sh" \
  --root "$STAGE_ROOT" --output "$STAGE_ROOT/DIST_MANIFEST.sha256" >/dev/null
"$STAGE_ROOT/scripts/verify-manifest.sh" \
  --root "$STAGE_ROOT" --manifest "$STAGE_ROOT/DIST_MANIFEST.sha256" >/dev/null

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
COPYFILE_DISABLE=1 tar -C "$STAGE_DIR" -czf "$TEMP_ARCHIVE" \
  "${tar_owner_args[@]}" "$ARCHIVE_ROOT"

# Validate the completed neighboring artifact before atomically replacing output.
python3 - "$TEMP_ARCHIVE" "$FILE_LIST" "$ARCHIVE_ROOT" <<'PY'
import hashlib
import os
import re
import sys
import tarfile

archive_path, list_path, archive_root = sys.argv[1:]
expected = set(open(list_path, "rb").read().split(b"\0"))
expected.discard(b"")
expected_names = {os.fsdecode(path) for path in expected}
expected_names.add("DIST_MANIFEST.sha256")
regular: dict[str, tarfile.TarInfo] = {}
directories: set[str] = set()
seen: set[str] = set()

with tarfile.open(archive_path, mode="r:gz") as archive:
    for member in archive.getmembers():
        name = member.name.rstrip("/")
        if name in seen:
            raise SystemExit(f"Duplicate archive member: {name}")
        seen.add(name)
        if name == archive_root:
            relative = ""
        elif name.startswith(f"{archive_root}/"):
            relative = name[len(archive_root) + 1 :]
        else:
            raise SystemExit(f"Archive member escaped root: {member.name}")
        parts = relative.split("/") if relative else []
        if any(part in ("", ".", "..") for part in parts):
            raise SystemExit(f"Unsafe archive path: {member.name}")
        if member.uid != 0 or member.gid != 0 or member.uname != "root" or member.gname != "root":
            raise SystemExit(f"Archive ownership is not normalized: {member.name}")
        if not (member.isdir() or member.isreg()):
            raise SystemExit(f"Archive contains a non-regular entry: {member.name}")
        if member.isreg():
            regular[relative] = member
        else:
            directories.add(relative)

        base = parts[-1] if parts else ""
        if (
            base.startswith("._")
            or base in {
                ".DS_Store",
                ".audio-roots.env",
                "state.json",
                "session.json",
            }
            or base.startswith(("chrome_profile", "browser_state"))
            or re.search(r"\.(mp3|wav|m4a|ogg|flac|aac|opus)$", base, re.I)
            or any(part in {"node_modules", "dist", ".git"} for part in parts)
        ):
            raise SystemExit(f"Archive contains a forbidden path: {member.name}")

    if set(regular) != expected_names:
        missing = sorted(expected_names - set(regular))
        extra = sorted(set(regular) - expected_names)
        raise SystemExit(f"Archive file set mismatch: missing={missing[:3]}, extra={extra[:3]}")
    expected_directories = {""}
    for relative in expected_names:
        parts = relative.split("/")[:-1]
        for length in range(1, len(parts) + 1):
            expected_directories.add("/".join(parts[:length]))
    if directories != expected_directories:
        missing = sorted(expected_directories - directories)
        extra = sorted(directories - expected_directories)
        raise SystemExit(f"Archive directory set mismatch: missing={missing[:3]}, extra={extra[:3]}")

    manifest_member = regular["DIST_MANIFEST.sha256"]
    manifest_file = archive.extractfile(manifest_member)
    if manifest_file is None:
        raise SystemExit("Cannot read staged manifest")
    manifest_entries: dict[str, str] = {}
    for line_number, raw in enumerate(manifest_file.read().splitlines(), 1):
        match = re.fullmatch(rb"([0-9a-f]{64})  (.+)", raw)
        if not match:
            raise SystemExit(f"Malformed staged manifest line {line_number}")
        relative = os.fsdecode(match.group(2))
        if relative in manifest_entries:
            raise SystemExit(f"Duplicate staged manifest path: {relative}")
        manifest_entries[relative] = match.group(1).decode("ascii")
    if set(manifest_entries) != expected_names - {"DIST_MANIFEST.sha256"}:
        raise SystemExit("Staged manifest does not describe the exact archive file set")
    for relative, expected_digest in manifest_entries.items():
        member_file = archive.extractfile(regular[relative])
        if member_file is None:
            raise SystemExit(f"Cannot read archive member: {relative}")
        if hashlib.sha256(member_file.read()).hexdigest() != expected_digest:
            raise SystemExit(f"Archive checksum mismatch: {relative}")
PY

chmod 0644 "$TEMP_ARCHIVE"
mv -f -- "$TEMP_ARCHIVE" "$OUTPUT"
echo "Wrote source-only archive: $OUTPUT"
