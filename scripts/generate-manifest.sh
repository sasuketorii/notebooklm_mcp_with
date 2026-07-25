#!/usr/bin/env bash
# Generates a portable release manifest without auth profiles, secrets,
# dependencies, build output, or caches.
set -euo pipefail
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=release-files.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/release-files.sh"

ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
OUTPUT=""
ROOT_SEEN=0
OUTPUT_SEEN=0
while (($#)); do
  case "$1" in
    --root)
      (($# >= 2)) || { echo "--root requires a directory" >&2; exit 2; }
      ((ROOT_SEEN == 0)) || { echo "--root may be specified only once" >&2; exit 2; }
      ROOT_SEEN=1
      ROOT_DIR="$2"
      shift 2
      ;;
    --output)
      (($# >= 2)) || { echo "--output requires a file" >&2; exit 2; }
      ((OUTPUT_SEEN == 0)) || { echo "--output may be specified only once" >&2; exit 2; }
      OUTPUT_SEEN=1
      OUTPUT="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--root DIR] [--output FILE]" >&2
      exit 2
      ;;
  esac
done

release_validate_root "$ROOT_DIR"
ROOT_DIR="$(cd -- "$ROOT_DIR" && pwd -P)"
OUTPUT="${OUTPUT:-"$ROOT_DIR/DIST_MANIFEST.sha256"}"
[[ -n "$OUTPUT" && ! -d "$OUTPUT" && ! -L "$OUTPUT" ]] || {
  echo "Manifest output must be a regular file path, not a directory or symlink: $OUTPUT" >&2
  exit 1
}
if [[ -e "$OUTPUT" && ! -f "$OUTPUT" ]]; then
  echo "Manifest output must be a regular file path: $OUTPUT" >&2
  exit 1
fi
OUTPUT_DIR="$(dirname -- "$OUTPUT")"
OUTPUT_BASE="$(basename -- "$OUTPUT")"
[[ "$OUTPUT_BASE" != "." && "$OUTPUT_BASE" != ".." &&
   "$OUTPUT_BASE" != *$'\n'* && "$OUTPUT_BASE" != *$'\r'* ]] || {
  echo "Unsafe manifest output path: $OUTPUT" >&2
  exit 1
}
[[ -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] || {
  echo "Manifest output parent must be a real directory: $OUTPUT_DIR" >&2
  exit 1
}
OUTPUT_DIR="$(cd -- "$OUTPUT_DIR" && pwd -P)"
OUTPUT="$OUTPUT_DIR/$OUTPUT_BASE"

FILE_LIST="$(mktemp "${TMPDIR:-/tmp}/notebooklm-release-files.XXXXXX")"
TEMP_OUTPUT="$(mktemp "$OUTPUT_DIR/.${OUTPUT_BASE}.tmp.XXXXXX")"
trap '/bin/rm -f -- "$FILE_LIST" "$TEMP_OUTPUT"' EXIT
release_collect_files "$ROOT_DIR" "$FILE_LIST"

# Never let a manifest overwrite, or become embedded in, the closed release
# file set. A custom root-level manifest name remains supported.
case "$OUTPUT" in
  "$ROOT_DIR"/*)
    OUTPUT_RELATIVE="${OUTPUT#"$ROOT_DIR/"}"
    case "$OUTPUT_RELATIVE" in
      .github/*|docs/*|scripts/*|src/*)
        echo "Manifest output must not be inside a release directory: $OUTPUT" >&2
        exit 1
        ;;
    esac
    while IFS= read -r -d '' relative; do
      [[ "$relative" != "$OUTPUT_RELATIVE" ]] || {
        echo "Manifest output must not replace a release file: $OUTPUT" >&2
        exit 1
      }
    done <"$FILE_LIST"
    ;;
esac

hash_file() {
  if command -v shasum >/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

while IFS= read -r -d '' relative; do
  printf '%s  %s\n' "$(hash_file "$ROOT_DIR/$relative")" "$relative"
done <"$FILE_LIST" >"$TEMP_OUTPUT"

chmod 0644 "$TEMP_OUTPUT"
mv -f -- "$TEMP_OUTPUT" "$OUTPUT"
echo "Wrote $OUTPUT"
