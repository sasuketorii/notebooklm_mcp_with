#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-lineage-test.XXXXXX")"
trap 'rm -rf -- "$TMP_ROOT"' EXIT
REPO="$TMP_ROOT/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.name "Lineage Test"
git -C "$REPO" config user.email "lineage@example.invalid"

empty_tree="$(git -C "$REPO" mktree </dev/null)"
commit_tree() {
  local message="$1"
  shift
  printf '%s\n' "$message" | git -C "$REPO" commit-tree "$empty_tree" "$@"
}
expect_failure() {
  local label="$1"
  shift
  if "$@" >"$TMP_ROOT/failure.out" 2>&1; then
    echo "Expected failure: $label" >&2
    exit 1
  fi
}
write_metadata() {
  local commit="$1"
  local tag="$2"
  local tree
  tree="$(git -C "$REPO" rev-parse "${commit}^{tree}")"
  cat >"$TMP_ROOT/baseline.json" <<EOF
{
  "upstream": {
    "repository": "https://github.com/PleasePrompto/notebooklm-mcp.git",
    "tag": "$tag",
    "auditTagRef": "refs/tags/upstream/notebooklm/$tag",
    "commit": "$commit",
    "tree": "$tree"
  },
  "lineageRoot": {
    "graftCommit": "$integration_v1",
    "publicParent": "$public_tip",
    "upstreamParent": "$upstream_v1",
    "preservedTree": "$empty_tree"
  }
}
EOF
  cat >"$TMP_ROOT/provenance.json" <<EOF
{
  "upstream": {
    "repository": "https://github.com/PleasePrompto/notebooklm-mcp.git",
    "tag": "$tag",
    "commit": "$commit"
  }
}
EOF
}
verify() {
  local head="$1"
  shift
  bash "$ROOT_DIR/scripts/verify-upstream-lineage.sh" \
    --repo "$REPO" \
    --baseline "$TMP_ROOT/baseline.json" \
    --provenance "$TMP_ROOT/provenance.json" \
    --head "$head" \
    --public-ref refs/heads/public \
    "$@"
}

upstream_v1="$(commit_tree "upstream v1")"
public_tip="$(commit_tree "public fork")"
integration_v1="$(commit_tree "ordinary integration v1" -p "$public_tip" -p "$upstream_v1")"
git -C "$REPO" update-ref refs/heads/public "$public_tip"
git -C "$REPO" update-ref refs/tags/upstream/notebooklm/v1.0.0 "$upstream_v1"
write_metadata "$upstream_v1" v1.0.0
verify "$integration_v1" >/dev/null

# Implementation and release commits may descend from the approved graft.
release_descendant="$(commit_tree "release descendant" -p "$integration_v1")"
verify "$release_descendant" >/dev/null
git -C "$REPO" update-ref refs/heads/public "$release_descendant"

# CI-like clean clone: only fork heads plus the durable namespaced audit tag
# are available. A coincidental bare upstream release tag must not be required.
git -C "$REPO" symbolic-ref HEAD refs/heads/public
clean_clone="$TMP_ROOT/clean-clone"
git clone -q --no-local "$REPO" "$clean_clone"
[[ -z "$(git -C "$clean_clone" show-ref --verify --hash refs/tags/v1.0.0 2>/dev/null || true)" ]]
[[ "$(git -C "$clean_clone" show-ref --verify --hash refs/tags/upstream/notebooklm/v1.0.0)" == "$upstream_v1" ]]
bash "$ROOT_DIR/scripts/verify-upstream-lineage.sh" \
  --repo "$clean_clone" \
  --baseline "$TMP_ROOT/baseline.json" \
  --provenance "$TMP_ROOT/provenance.json" \
  --head refs/heads/public \
  --public-ref refs/heads/public >/dev/null
wrong_audit_target="$(commit_tree "wrong audit target")"
git -C "$REPO" update-ref refs/tags/upstream/notebooklm/v1.0.0 "$wrong_audit_target"
expect_failure "audit tag target mismatch" verify "$release_descendant"
git -C "$REPO" update-ref refs/tags/upstream/notebooklm/v1.0.0 "$upstream_v1"

# A synthetic future upstream must remain an ordinary second-parent merge.
upstream_v2="$(commit_tree "upstream v2" -p "$upstream_v1")"
integration_v2="$(commit_tree "ordinary integration v2" -p "$release_descendant" -p "$upstream_v2")"
git -C "$REPO" update-ref refs/tags/upstream/notebooklm/v2.0.0 "$upstream_v2"
verify "$integration_v1" --candidate "$upstream_v2" >/dev/null
write_metadata "$upstream_v2" v2.0.0
verify "$integration_v2" >/dev/null

unrelated="$(commit_tree "unrelated root")"
write_metadata "$upstream_v1" v1.0.0
expect_failure "unrelated candidate" verify "$integration_v1" --candidate "$unrelated"
write_metadata "$upstream_v2" v2.0.0
bad_merge="$(commit_tree "wrong second parent" -p "$public_tip" -p "$unrelated")"
expect_failure "unrelated second parent" verify "$bad_merge"

bad_tree="$(git -C "$REPO" rev-parse "${public_tip}^{tree}")"
node - "$TMP_ROOT/baseline.json" "$bad_tree" <<'NODE'
const fs = require("node:fs");
const [path, tree] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.upstream.tree = tree;
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
# The empty-tree fixtures share a tree, so use a syntactically valid absent tree.
node - "$TMP_ROOT/baseline.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.upstream.tree = "0000000000000000000000000000000000000000";
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
expect_failure "tree mismatch" verify "$integration_v2"
write_metadata "$upstream_v2" v2.0.0

legacy_custom="$(commit_tree "legacy unpublished custom" -p "$upstream_v1")"
git -C "$REPO" update-ref refs/heads/custom/legacy "$legacy_custom"
legacy_merge="$(commit_tree "merge that leaks legacy history" \
  -p "$public_tip" -p "$upstream_v2" -p "$legacy_custom")"
expect_failure "legacy unpublished history" verify "$legacy_merge"

second_graft="$(commit_tree "duplicate baseline integration" \
  -p "$integration_v2" -p "$upstream_v2")"
expect_failure "second baseline graft" verify "$second_graft"

update_script="$ROOT_DIR/scripts/update-upstream.sh"
expect_failure "short SHA" bash "$update_script" deadbeef --tag v9.9.9
expect_failure "non-stable tag" \
  bash "$update_script" 1111111111111111111111111111111111111111 --tag v2.0
expect_failure "generator non-stable tag" \
  node "$ROOT_DIR/scripts/generate-upstream-baseline.mjs" \
    1111111111111111111111111111111111111111 "$TMP_ROOT/invalid.json" v2.0-rc1
expect_failure "repeated reviewed baseline" \
  bash "$update_script" "$(
    node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("UPSTREAM_BASELINE.json")).upstream.commit)'
  )" --tag v2.0.0
if rg -n -- 'fetch.*--tags|-X[[:space:]]+ours|REMOTE=origin|git push' \
  "$update_script" >/dev/null; then
  echo "Updater contains a forbidden broad-fetch, ours, or push pattern" >&2
  exit 1
fi
if sed '/^cat <<EOF/,$d' "$update_script" |
  rg -n '^[[:space:]]*git merge([[:space:]]|$)' >/dev/null; then
  echo "Updater executes a scripted merge instead of stopping for manual review" >&2
  exit 1
fi

echo "Upstream lineage synthetic tests passed"
