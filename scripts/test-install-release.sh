#!/usr/bin/env bash
# Isolated release-binding tests; all public repositories are local bare remotes.
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
VERIFY="$ROOT_DIR/scripts/verify-install-release.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-release-install-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$TEST_ROOT/failure.out" 2>&1; then
    echo "Expected release verification failure: $label" >&2
    exit 1
  fi
}

write_release_files() {
  local repo="$1"
  mkdir -p "$repo/src"
  cat > "$repo/package.json" <<'EOF'
{"name":"notebooklm-mcp-audio-custom","version":"0.0.3"}
EOF
  cat > "$repo/package-lock.json" <<'EOF'
{
  "name": "notebooklm-mcp-audio-custom",
  "version": "0.0.3",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "notebooklm-mcp-audio-custom",
      "version": "0.0.3"
    }
  }
}
EOF
  cat > "$repo/RELEASE_PROVENANCE.json" <<'EOF'
{"distribution":"notebooklm-mcp-audio-custom","custom_version":"0.0.3"}
EOF
  cat > "$repo/src/version.ts" <<'EOF'
export const SERVER_VERSION = "0.0.3";
EOF
  cat > "$repo/.gitignore" <<'EOF'
.audio-roots.env
node_modules/
dist/
DIST_MANIFEST.sha256
EOF
}

make_public_release() {
  local label="$1" mutation="${2:-none}" tag_mode="${3:-current}"
  local seed="$TEST_ROOT/$label-seed"
  local public="$TEST_ROOT/$label-public.git"
  local checkout="$TEST_ROOT/$label-checkout"
  mkdir -p "$seed"
  git -C "$seed" init -q -b main
  git -C "$seed" config user.name "Release Test"
  git -C "$seed" config user.email "release@example.invalid"
  write_release_files "$seed"
  git -C "$seed" add .
  git -C "$seed" commit -q -m "base release"

  if [[ "$tag_mode" == previous ]]; then
    git -C "$seed" tag -a v0.0.3 -m "wrong release target"
    printf 'release-head\n' > "$seed/README.md"
    git -C "$seed" add README.md
    git -C "$seed" commit -q -m "published main after tag"
  fi

  case "$mutation" in
    none) ;;
    provenance-version)
      node - "$seed/RELEASE_PROVENANCE.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.custom_version = "9.9.9";
fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
NODE
      git -C "$seed" add RELEASE_PROVENANCE.json
      git -C "$seed" commit -q -m "tamper provenance version"
      ;;
    *) echo "Unknown fixture mutation: $mutation" >&2; exit 2 ;;
  esac

  if [[ "$tag_mode" == current ]]; then
    git -C "$seed" tag -a v0.0.3 -m "release v0.0.3"
  elif [[ "$tag_mode" != previous && "$tag_mode" != missing ]]; then
    echo "Unknown tag mode: $tag_mode" >&2
    exit 2
  fi

  git clone -q --bare "$seed" "$public"
  git clone -q "$public" "$checkout"
  printf '%s\t%s' "$checkout" "$public"
}

IFS=$'\t' read -r clean_checkout clean_public <<< "$(make_public_release clean)"
"$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public" >/dev/null

# Ignored runtime state is not part of the shipping worktree and remains allowed.
printf 'NOTEBOOKLM_AUDIO_ROOTS=/private/runtime\n' > "$clean_checkout/.audio-roots.env"
"$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public" >/dev/null

printf 'ignored release manifest\n' > "$clean_checkout/DIST_MANIFEST.sha256"
expect_failure "ignored release manifest" \
  "$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public"
rm -f -- "$clean_checkout/DIST_MANIFEST.sha256"

mkdir -p "$clean_checkout/tmp"
printf 'hidden shipping file\n' > "$clean_checkout/tmp/hidden-script.sh"
expect_failure "repo-ignored non-runtime shipping file" \
  "$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public"
rm -rf -- "$clean_checkout/tmp"

outside_dist="$TEST_ROOT/outside-dist-target"
printf 'outside\n' > "$outside_dist"
mkdir -p "$clean_checkout/dist"
ln -s "$outside_dist" "$clean_checkout/dist/index.js"
expect_failure "ignored dist symlink" \
  "$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public"
rm -rf -- "$clean_checkout/dist"

printf 'locally-hidden-file\n' >> "$clean_checkout/.git/info/exclude"
printf 'hidden by info exclude\n' > "$clean_checkout/locally-hidden-file"
expect_failure "active per-clone info/exclude rule" \
  "$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public"
sed -i.bak '/^locally-hidden-file$/d' "$clean_checkout/.git/info/exclude"
rm -f -- "$clean_checkout/.git/info/exclude.bak" "$clean_checkout/locally-hidden-file"

printf '\n' >> "$clean_checkout/package.json"
expect_failure "dirty tracked shipping file" \
  "$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public"
git -C "$clean_checkout" restore package.json

printf 'untracked\n' > "$clean_checkout/UNTRACKED-SHIPPING-FILE"
expect_failure "non-ignored untracked shipping file" \
  "$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public"
rm -f -- "$clean_checkout/UNTRACKED-SHIPPING-FILE"

IFS=$'\t' read -r mismatch_checkout mismatch_public \
  <<< "$(make_public_release version-mismatch provenance-version current)"
expect_failure "package, lock, provenance, and source version disagreement" \
  "$VERIFY" --repo "$mismatch_checkout" --public-repository "$mismatch_public"

IFS=$'\t' read -r untagged_checkout untagged_public \
  <<< "$(make_public_release untagged none missing)"
expect_failure "unreleased HEAD without exact stable tag" \
  "$VERIFY" --repo "$untagged_checkout" --public-repository "$untagged_public"

IFS=$'\t' read -r wrong_tag_checkout wrong_tag_public \
  <<< "$(make_public_release wrong-tag none previous)"
expect_failure "stable tag does not point at HEAD" \
  "$VERIFY" --repo "$wrong_tag_checkout" --public-repository "$wrong_tag_public"

# A locally moved tag cannot hide a different public tag target.
git -C "$wrong_tag_checkout" tag -f v0.0.3 HEAD >/dev/null
expect_failure "public stable tag does not point at HEAD" \
  "$VERIFY" --repo "$wrong_tag_checkout" --public-repository "$wrong_tag_public"

# A previously published checkout stops being installable after public main moves.
public_seed="$TEST_ROOT/public-main-advance"
git clone -q "$clean_public" "$public_seed"
git -C "$public_seed" config user.name "Release Test"
git -C "$public_seed" config user.email "release@example.invalid"
printf 'next\n' > "$public_seed/NEXT"
git -C "$public_seed" add NEXT
git -C "$public_seed" commit -q -m "advance public main"
git -C "$public_seed" push -q origin main
expect_failure "HEAD is not the currently published main commit" \
  "$VERIFY" --repo "$clean_checkout" --public-repository "$clean_public"

echo "install release binding tests: PASS"
