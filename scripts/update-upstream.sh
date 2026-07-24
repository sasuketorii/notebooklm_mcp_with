#!/usr/bin/env bash
# Compare this fork with upstream by default. Apply is explicit and requires a clean worktree.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
REMOTE="${NOTEBOOKLM_UPSTREAM_REMOTE:-}"
if [[ -z "$REMOTE" ]]; then
  if git remote get-url upstream >/dev/null 2>&1; then REMOTE=upstream; else REMOTE=origin; fi
fi
BRANCH="${NOTEBOOKLM_UPSTREAM_BRANCH:-main}"
UPSTREAM_REF="$REMOTE/$BRANCH"
APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) UPSTREAM_REF="$arg" ;;
  esac
done

git remote get-url "$REMOTE" >/dev/null
fetch_args=(--tags --prune)
[[ -f "$(git rev-parse --git-dir)/shallow" ]] && fetch_args+=(--unshallow)
git fetch "${fetch_args[@]}" "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH"
echo "Custom fork: $(git rev-parse --short HEAD)"
echo "Upstream ref: $UPSTREAM_REF ($(git rev-parse --short "$UPSTREAM_REF"))"
git log --oneline --left-right HEAD..."$UPSTREAM_REF"

if "$APPLY"; then
  [[ -z "$(git status --porcelain)" ]] || { echo "Refusing update: commit custom edits first, or export them with: git diff > custom-audio.patch" >&2; exit 1; }
  # Never open an editor in an unattended install/update flow.
  git merge --no-ff --no-edit "$UPSTREAM_REF"
  npm ci
  npm run check
  npm test
  ./scripts/generate-manifest.sh
  ./scripts/verify-manifest.sh
  echo "Automated update checks passed. Perform the manual visible-browser audio smoke before release."
fi
