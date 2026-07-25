#!/usr/bin/env bash
set -euo pipefail

readonly CANONICAL_UPSTREAM_URL="https://github.com/PleasePrompto/notebooklm-mcp.git"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$ROOT_DIR"
BASELINE_FILE="$ROOT_DIR/UPSTREAM_BASELINE.json"
PROVENANCE_FILE="$ROOT_DIR/RELEASE_PROVENANCE.json"
HEAD_REF="HEAD"
PUBLIC_REF="origin/main"
REQUIRE_TAG=true
CANDIDATE_REF=""

while (($#)); do
  case "$1" in
    --repo) REPO="$(cd -- "$2" && pwd -P)"; shift 2 ;;
    --baseline) BASELINE_FILE="$2"; shift 2 ;;
    --provenance) PROVENANCE_FILE="$2"; shift 2 ;;
    --head) HEAD_REF="$2"; shift 2 ;;
    --public-ref) PUBLIC_REF="$2"; shift 2 ;;
    --candidate) CANDIDATE_REF="$2"; shift 2 ;;
    --skip-tag-check) REQUIRE_TAG=false; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

json_field() {
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let value = data;
    for (const key of process.argv[2].split(".")) value = value?.[key];
    if (typeof value !== "string") process.exit(3);
    process.stdout.write(value);
  ' "$1" "$2"
}

die() { echo "Lineage verification failed: $*" >&2; exit 1; }
git_repo() { git -C "$REPO" "$@"; }

[[ -f "$BASELINE_FILE" ]] || die "missing baseline file: $BASELINE_FILE"
[[ -f "$PROVENANCE_FILE" ]] || die "missing provenance file: $PROVENANCE_FILE"

baseline_repo="$(json_field "$BASELINE_FILE" upstream.repository)" ||
  die "invalid baseline repository"
baseline_tag="$(json_field "$BASELINE_FILE" upstream.tag)" || die "invalid baseline tag"
baseline_audit_tag_ref="$(json_field "$BASELINE_FILE" upstream.auditTagRef)" ||
  die "invalid baseline audit tag ref"
baseline_commit="$(json_field "$BASELINE_FILE" upstream.commit)" ||
  die "invalid baseline commit"
baseline_tree="$(json_field "$BASELINE_FILE" upstream.tree)" || die "invalid baseline tree"
graft_commit="$(json_field "$BASELINE_FILE" lineageRoot.graftCommit)" ||
  die "invalid lineage root graft commit"
graft_public_parent="$(json_field "$BASELINE_FILE" lineageRoot.publicParent)" ||
  die "invalid lineage root public parent"
graft_upstream_parent="$(json_field "$BASELINE_FILE" lineageRoot.upstreamParent)" ||
  die "invalid lineage root upstream parent"
graft_preserved_tree="$(json_field "$BASELINE_FILE" lineageRoot.preservedTree)" ||
  die "invalid lineage root preserved tree"
provenance_repo="$(json_field "$PROVENANCE_FILE" upstream.repository)" ||
  die "invalid provenance repository"
provenance_commit="$(json_field "$PROVENANCE_FILE" upstream.commit)" ||
  die "invalid provenance commit"

[[ "$baseline_repo" == "$CANONICAL_UPSTREAM_URL" ]] ||
  die "baseline repository is not canonical"
[[ "$provenance_repo" == "$CANONICAL_UPSTREAM_URL" ]] ||
  die "release provenance repository is not canonical"
[[ "$baseline_commit" =~ ^[0-9a-f]{40}$ ]] || die "baseline commit is not an exact 40-SHA"
[[ "$baseline_audit_tag_ref" == "refs/tags/upstream/notebooklm/$baseline_tag" ]] ||
  die "baseline audit tag ref does not match the reviewed upstream tag"
[[ "$provenance_commit" == "$baseline_commit" ]] ||
  die "release provenance commit does not match the reviewed baseline"
[[ "$(git_repo cat-file -t "$baseline_commit" 2>/dev/null || true)" == "commit" ]] ||
  die "baseline commit is not present as a commit"
[[ "$(git_repo rev-parse "${baseline_commit}^{tree}")" == "$baseline_tree" ]] ||
  die "baseline tree does not match the reviewed tree"

if "$REQUIRE_TAG"; then
  [[ "$(git_repo rev-parse "${baseline_audit_tag_ref}^{commit}" 2>/dev/null || true)" == "$baseline_commit" ]] ||
    die "durable audit tag does not resolve to the reviewed upstream commit: $baseline_audit_tag_ref"
fi

git_repo merge-base --is-ancestor "$baseline_commit" "$HEAD_REF" ||
  die "reviewed upstream baseline is not an ancestor of $HEAD_REF"
if [[ -n "$CANDIDATE_REF" ]]; then
  candidate_commit="$(git_repo rev-parse "${CANDIDATE_REF}^{commit}" 2>/dev/null)" ||
    die "candidate ref is unavailable: $CANDIDATE_REF"
  git_repo merge-base --is-ancestor "$baseline_commit" "$candidate_commit" ||
    die "candidate is unrelated to or behind reviewed upstream provenance"
fi

public_commit="$(git_repo rev-parse "${PUBLIC_REF}^{commit}" 2>/dev/null)" ||
  die "public ref is unavailable: $PUBLIC_REF"

[[ "$graft_commit" =~ ^[0-9a-f]{40}$ ]] || die "root graft is not an exact 40-SHA"
[[ "$graft_public_parent" =~ ^[0-9a-f]{40}$ ]] ||
  die "root graft public parent is not an exact 40-SHA"
[[ "$graft_upstream_parent" =~ ^[0-9a-f]{40}$ ]] ||
  die "root graft upstream parent is not an exact 40-SHA"
[[ "$(git_repo cat-file -t "$graft_commit" 2>/dev/null || true)" == "commit" ]] ||
  die "approved root graft is absent"
read -r actual_graft_first actual_graft_second graft_extra \
  <<<"$(git_repo show -s --format=%P "$graft_commit")"
[[ "$actual_graft_first" == "$graft_public_parent" &&
   "$actual_graft_second" == "$graft_upstream_parent" &&
   -z "${graft_extra:-}" ]] ||
  die "approved root graft parents do not match provenance"
[[ "$(git_repo rev-parse "${graft_commit}^{tree}")" == "$graft_preserved_tree" ]] ||
  die "approved root graft tree does not match provenance"
[[ "$(git_repo rev-parse "${graft_public_parent}^{tree}")" == "$graft_preserved_tree" ]] ||
  die "approved root graft did not preserve the public parent's tree"
git_repo merge-base --is-ancestor "$graft_commit" "$HEAD_REF" ||
  die "approved root graft is not an ancestor of $HEAD_REF"
git_repo merge-base --is-ancestor "$graft_public_parent" "$public_commit" ||
  die "public ref does not descend from the approved pre-graft public parent"
git_repo merge-base --is-ancestor "$graft_upstream_parent" "$baseline_commit" ||
  die "reviewed upstream baseline does not descend from the root upstream parent"

root_graft_count=0
baseline_integration_count=0
while IFS= read -r merge_commit; do
  [[ -n "$merge_commit" ]] || continue
  read -r merge_first merge_second merge_extra \
    <<<"$(git_repo show -s --format=%P "$merge_commit")"
  if [[ "$merge_second" == "$graft_upstream_parent" ]]; then
    root_graft_count=$((root_graft_count + 1))
    [[ "$merge_commit" == "$graft_commit" ]] ||
      die "a second graft of the root upstream parent is reachable: $merge_commit"
  fi
  if [[ "$merge_second" == "$baseline_commit" ]]; then
    baseline_integration_count=$((baseline_integration_count + 1))
  fi
done < <(git_repo rev-list --merges "$HEAD_REF")
[[ "$root_graft_count" -eq 1 ]] || die "approved root graft is not unique"
[[ "$baseline_integration_count" -eq 1 ]] ||
  die "reviewed upstream baseline must have exactly one ordinary integration merge"

# A local pre-public custom branch may remain as an audit artifact. None of its
# custom-only commits may become reachable from the integration result.
while IFS= read -r legacy_ref; do
  [[ -n "$legacy_ref" ]] || continue
  while IFS= read -r legacy_commit; do
    [[ -n "$legacy_commit" ]] || continue
    if git_repo merge-base --is-ancestor "$legacy_commit" "$HEAD_REF"; then
      die "unpublished legacy custom commit became reachable: $legacy_commit ($legacy_ref)"
    fi
  done < <(git_repo rev-list "$legacy_ref" --not "$baseline_commit" "$PUBLIC_REF")
done < <(git_repo for-each-ref --format='%(refname)' "refs/heads/custom/*")

echo "Upstream lineage verified:"
echo "  canonical repository: $CANONICAL_UPSTREAM_URL"
echo "  reviewed baseline: $baseline_commit"
echo "  durable audit tag: $baseline_audit_tag_ref"
echo "  reviewed tree: $baseline_tree"
echo "  approved root graft: $graft_commit"
echo "  current public ref: $public_commit"
echo "  verified descendant: $(git_repo rev-parse "${HEAD_REF}^{commit}")"
