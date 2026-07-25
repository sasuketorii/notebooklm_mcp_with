#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=release-files.sh
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/release-files.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-source-release-test.XXXXXX")"
trap '/bin/rm -rf -- "$TEST_ROOT"' EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$TEST_ROOT/failure.out" 2>&1; then
    echo "Expected failure: $label" >&2
    exit 1
  fi
}

copy_fixture() {
  local target="$1" list="$TEST_ROOT/copy.$$.nul" relative
  mkdir -p "$target"
  release_collect_files "$ROOT_DIR" "$list"
  while IFS= read -r -d '' relative; do
    mkdir -p "$target/$(dirname -- "$relative")"
    cp -pP -- "$ROOT_DIR/$relative" "$target/$relative"
  done <"$list"
  /bin/rm -f -- "$list"
}

FIXTURE="$TEST_ROOT/release fixture"
copy_fixture "$FIXTURE"

# Zero-argument compatibility and explicit paths, including spaces.
(
  cd "$FIXTURE"
  ./scripts/generate-manifest.sh >/dev/null
  ./scripts/verify-manifest.sh >/dev/null
)
EXPLICIT_MANIFEST="$TEST_ROOT/explicit manifest.sha256"
"$FIXTURE/scripts/generate-manifest.sh" \
  --root "$FIXTURE" --output "$EXPLICIT_MANIFEST" >/dev/null
"$FIXTURE/scripts/verify-manifest.sh" \
  --root "$FIXTURE" --manifest "$EXPLICIT_MANIFEST" >/dev/null

expect_failure "unknown generate argument" "$FIXTURE/scripts/generate-manifest.sh" --unknown
expect_failure "missing generate root" "$FIXTURE/scripts/generate-manifest.sh" --root
expect_failure "duplicate generate output" \
  "$FIXTURE/scripts/generate-manifest.sh" --output "$TEST_ROOT/a" --output "$TEST_ROOT/b"
expect_failure "unknown verify argument" "$FIXTURE/scripts/verify-manifest.sh" --unknown
expect_failure "missing verify manifest" "$FIXTURE/scripts/verify-manifest.sh" --manifest
expect_failure "duplicate verify root" \
  "$FIXTURE/scripts/verify-manifest.sh" --root "$FIXTURE" --root "$FIXTURE"
expect_failure "manifest overwrites release file" \
  "$FIXTURE/scripts/generate-manifest.sh" --root "$FIXTURE" --output "$FIXTURE/package.json"

mkfifo "$TEST_ROOT/output.fifo"
expect_failure "manifest output FIFO" \
  "$FIXTURE/scripts/generate-manifest.sh" --root "$FIXTURE" --output "$TEST_ROOT/output.fifo"
/bin/rm -f -- "$TEST_ROOT/output.fifo"

# Content tampering, unsafe manifest paths, symlinks, and non-regular files fail closed.
printf '\n' >>"$FIXTURE/README.md"
expect_failure "tampered release file" \
  "$FIXTURE/scripts/verify-manifest.sh" --root "$FIXTURE" --manifest "$EXPLICIT_MANIFEST"
cp -p -- "$ROOT_DIR/README.md" "$FIXTURE/README.md"

cp "$EXPLICIT_MANIFEST" "$TEST_ROOT/unsafe-manifest"
printf '%064d  ../escape\n' 0 >>"$TEST_ROOT/unsafe-manifest"
expect_failure "unsafe manifest path" \
  "$FIXTURE/scripts/verify-manifest.sh" --root "$FIXTURE" --manifest "$TEST_ROOT/unsafe-manifest"

ln -s "$EXPLICIT_MANIFEST" "$TEST_ROOT/manifest-link"
expect_failure "manifest symlink" \
  "$FIXTURE/scripts/verify-manifest.sh" --root "$FIXTURE" --manifest "$TEST_ROOT/manifest-link"
ln -s "$FIXTURE" "$TEST_ROOT/root-link"
expect_failure "root symlink" "$FIXTURE/scripts/generate-manifest.sh" --root "$TEST_ROOT/root-link"

/bin/rm -f -- "$FIXTURE/src/version.ts"
ln -s "$ROOT_DIR/src/version.ts" "$FIXTURE/src/version.ts"
expect_failure "release symlink" \
  "$FIXTURE/scripts/generate-manifest.sh" --root "$FIXTURE" --output "$TEST_ROOT/symlink.sha256"
/bin/rm -f -- "$FIXTURE/src/version.ts"
cp -p -- "$ROOT_DIR/src/version.ts" "$FIXTURE/src/version.ts"

mkfifo "$FIXTURE/docs/release-test.fifo"
expect_failure "release FIFO" \
  "$FIXTURE/scripts/generate-manifest.sh" --root "$FIXTURE" --output "$TEST_ROOT/fifo.sha256"
/bin/rm -f -- "$FIXTURE/docs/release-test.fifo"

# A find failure cannot be hidden by process substitution and leaves an existing
# destination byte-for-byte unchanged without adjacent temporary files.
FAKE_BIN="$TEST_ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/find" <<'EOF'
#!/usr/bin/env bash
exit 71
EOF
chmod +x "$FAKE_BIN/find"
printf 'manifest-sentinel\n' >"$TEST_ROOT/existing-manifest"
PATH="$FAKE_BIN:$PATH" expect_failure "find failure" \
  "$FIXTURE/scripts/generate-manifest.sh" \
  --root "$FIXTURE" --output "$TEST_ROOT/existing-manifest"
grep -Fqx 'manifest-sentinel' "$TEST_ROOT/existing-manifest"
if compgen -G "$TEST_ROOT/.existing-manifest.tmp.*" >/dev/null; then
  echo "Failed manifest generation left an adjacent temporary file" >&2
  exit 1
fi

# Source release generation is stage-only: an absent root manifest remains
# absent, and a pre-existing root sentinel remains untouched.
/bin/rm -f -- "$FIXTURE/DIST_MANIFEST.sha256"
OUTPUT="$TEST_ROOT/source archive.tar.gz"
"$FIXTURE/scripts/make-source-release.sh" "$OUTPUT" >/dev/null
[[ ! -e "$FIXTURE/DIST_MANIFEST.sha256" ]]
printf 'repository-sentinel\n' >"$FIXTURE/DIST_MANIFEST.sha256"
"$FIXTURE/scripts/make-source-release.sh" "$OUTPUT" >/dev/null
grep -Fqx 'repository-sentinel' "$FIXTURE/DIST_MANIFEST.sha256"

# Exact archive file set, ownership, member types, layout, and staged manifest.
python3 - "$OUTPUT" "$EXPLICIT_MANIFEST" <<'PY'
import sys
import tarfile

archive_path, manifest_path = sys.argv[1:]
expected = {
    line.split("  ", 1)[1]
    for line in open(manifest_path, encoding="utf-8").read().splitlines()
}
expected.add("DIST_MANIFEST.sha256")
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    regular = {
        member.name.removeprefix("notebooklm-mcp-audio-custom/")
        for member in members
        if member.isfile()
    }
    if regular != expected:
        raise SystemExit(f"archive set mismatch: missing={expected-regular}, extra={regular-expected}")
    bad = [
        member.name
        for member in members
        if (
            not (member.isdir() or member.isfile())
            or member.uid != 0
            or member.gid != 0
            or member.uname != "root"
            or member.gname != "root"
        )
    ]
    if bad:
        raise SystemExit(f"archive metadata mismatch: {bad[:3]}")
PY

# Concurrent distinct outputs and concurrent writers to the same output all
# leave complete, independently verifiable closed archives.
pids=()
for output in "$TEST_ROOT/concurrent-a.tar.gz" "$TEST_ROOT/concurrent-b.tar.gz"; do
  "$FIXTURE/scripts/make-source-release.sh" "$output" >/dev/null &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done

SAME_OUTPUT="$TEST_ROOT/concurrent-same.tar.gz"
pids=()
for _ in 1 2 3; do
  "$FIXTURE/scripts/make-source-release.sh" "$SAME_OUTPUT" >/dev/null &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
tar -tzf "$SAME_OUTPUT" >/dev/null

# A tar failure preserves an existing output and leaves no neighboring temp.
cat >"$FAKE_BIN/tar" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "tar (GNU tar) 1.35"
  exit 0
fi
exit 72
EOF
chmod +x "$FAKE_BIN/tar"
printf 'archive-sentinel\n' >"$TEST_ROOT/existing.tar.gz"
PATH="$FAKE_BIN:$PATH" expect_failure "tar creation failure" \
  "$FIXTURE/scripts/make-source-release.sh" "$TEST_ROOT/existing.tar.gz"
grep -Fqx 'archive-sentinel' "$TEST_ROOT/existing.tar.gz"
if compgen -G "$TEST_ROOT/.existing.tar.gz.tmp.*" >/dev/null; then
  echo "Failed archive generation left an adjacent temporary file" >&2
  exit 1
fi

echo "Source release archive and manifest tests: PASS"
