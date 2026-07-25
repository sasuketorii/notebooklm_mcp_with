#!/usr/bin/env bash
# Prepare a review-only integration branch from one exact, tagged upstream commit.
# This script never updates main/release refs and never pushes.
set -euo pipefail

readonly CANONICAL_UPSTREAM_URL="https://github.com/PleasePrompto/notebooklm-mcp.git"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"

TARGET_SHA=""
TARGET_TAG=""
while (($#)); do
  case "$1" in
    --tag) TARGET_TAG="${2:-}"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 <exact-40-sha> --tag <exact-stable-tag>"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      [[ -z "$TARGET_SHA" ]] || { echo "Only one target SHA is accepted" >&2; exit 2; }
      TARGET_SHA="$1"
      shift
      ;;
  esac
done

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  { echo "An exact lowercase 40-character upstream commit SHA is required" >&2; exit 2; }
[[ "$TARGET_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  { echo "A reviewed upstream tag is required with --tag" >&2; exit 2; }

baseline_fields="$(node -e '
  const value = JSON.parse(require("node:fs").readFileSync("UPSTREAM_BASELINE.json", "utf8"));
  process.stdout.write([
    value.upstream.repository,
    value.upstream.tag,
    value.upstream.auditTagRef,
    value.upstream.commit,
    value.upstream.tree,
  ].join("\t"));
')"
IFS=$'\t' read -r baseline_repository baseline_tag baseline_audit_tag_ref baseline_commit baseline_tree \
  <<<"$baseline_fields"
provenance_fields="$(node -e '
  const value = JSON.parse(require("node:fs").readFileSync("RELEASE_PROVENANCE.json", "utf8"));
  process.stdout.write([
    value.upstream.repository,
    value.upstream.tag,
    value.upstream.commit,
  ].join("\t"));
')"
IFS=$'\t' read -r provenance_repository provenance_tag provenance_commit \
  <<<"$provenance_fields"
[[ "$baseline_repository" == "$CANONICAL_UPSTREAM_URL" ]] ||
  { echo "UPSTREAM_BASELINE.json does not name the canonical repository" >&2; exit 1; }
[[ "$baseline_audit_tag_ref" == "refs/tags/upstream/notebooklm/$baseline_tag" ]] ||
  { echo "UPSTREAM_BASELINE.json has an invalid durable audit tag ref" >&2; exit 1; }
[[ "$provenance_repository" == "$CANONICAL_UPSTREAM_URL" ]] ||
  { echo "RELEASE_PROVENANCE.json does not name the canonical repository" >&2; exit 1; }
[[ "$baseline_commit" =~ ^[0-9a-f]{40}$ ]] ||
  { echo "UPSTREAM_BASELINE.json has no exact reviewed commit" >&2; exit 1; }
[[ "$provenance_commit" == "$baseline_commit" ]] ||
  { echo "Release provenance and baseline disagree; refusing update" >&2; exit 1; }
[[ "$provenance_tag" == "$baseline_tag" ]] ||
  { echo "Release provenance and baseline tags disagree; refusing update" >&2; exit 1; }
[[ "$(git rev-parse "${baseline_commit}^{tree}" 2>/dev/null || true)" == "$baseline_tree" ]] ||
  { echo "Reviewed baseline tree is absent or does not match provenance" >&2; exit 1; }
[[ "$TARGET_SHA" != "$baseline_commit" ]] ||
  { echo "Target is already the reviewed upstream baseline; refusing repeated integration" >&2; exit 1; }

candidate_ref="refs/notebooklm-upstream/commits/$TARGET_SHA"
tag_ref="refs/notebooklm-upstream/tags/$TARGET_TAG"
git fetch --no-tags "$CANONICAL_UPSTREAM_URL" \
  "$TARGET_SHA:$candidate_ref" \
  "refs/tags/$TARGET_TAG:$tag_ref"
[[ "$(git rev-parse "${candidate_ref}^{commit}")" == "$TARGET_SHA" ]] ||
  { echo "Fetched candidate does not match the requested exact SHA" >&2; exit 1; }
[[ "$(git rev-parse "${tag_ref}^{commit}")" == "$TARGET_SHA" ]] ||
  { echo "Reviewed tag does not resolve to the requested exact SHA" >&2; exit 1; }
git merge-base --is-ancestor "$baseline_commit" "$TARGET_SHA" ||
  { echo "Upstream target is not a fast-forward of reviewed provenance" >&2; exit 1; }

echo "Reviewed baseline: $baseline_commit"
echo "Candidate upstream: $TARGET_SHA ($TARGET_TAG)"
git log --oneline --left-right "$baseline_commit...$TARGET_SHA"

integration_branch="integration/upstream-$TARGET_SHA"
durable_audit_tag="upstream/notebooklm/$TARGET_TAG"
cat <<EOF
Candidate validation passed. This script intentionally stops before any local merge.

After reviewer approval, run these commands manually:
  git switch -c $integration_branch origin/main
  git merge --no-ff --no-commit $candidate_ref

Then review every upstream diff and conflict before committing. After the manual
merge is accepted, regenerate the reviewed baseline/provenance, build, run:
  node scripts/generate-upstream-baseline.mjs $TARGET_SHA UPSTREAM_BASELINE.json $TARGET_TAG
  node scripts/verify-tool-compatibility.mjs

Do not regenerate CUSTOM_TOOL_CONTRACTS.json merely to silence a failure.
Any custom contract change requires explicit schema/annotation review first.

After the merge, contract review, and runtime smoke pass, create the durable
non-release audit tag manually:
  git tag $durable_audit_tag $TARGET_SHA
  bash scripts/verify-upstream-lineage.sh

Obtain final reviewer LGTM, then push that audit tag together with the reviewed
custom release tag. The verifier requires refs/tags/$durable_audit_tag in clean
clones and CI.

Nothing was merged, no main/release ref was updated, and nothing was pushed.
EOF
