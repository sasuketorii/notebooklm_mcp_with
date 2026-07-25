#!/usr/bin/env bash
# Fail closed unless this checkout is the exact clean, publicly published release.
set -euo pipefail

readonly DEFAULT_PUBLIC_REPOSITORY="https://github.com/sasuketorii/notebooklm_mcp_with.git"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$ROOT_DIR"
PUBLIC_REPOSITORY="$DEFAULT_PUBLIC_REPOSITORY"

while (($#)); do
  case "$1" in
    --repo)
      (($# >= 2)) || { echo "--repo requires PATH" >&2; exit 2; }
      REPO="$(cd -- "$2" && pwd -P)"
      shift 2
      ;;
    --public-repository)
      (($# >= 2)) || { echo "--public-repository requires URL" >&2; exit 2; }
      PUBLIC_REPOSITORY="$2"
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() {
  echo "Install release verification failed: $*" >&2
  exit 1
}

safe_git() {
  git \
    -c core.fsmonitor=false \
    -c core.hooksPath=/dev/null \
    -c core.attributesFile=/dev/null \
    -c core.excludesFile=/dev/null \
    -c diff.external= \
    -c pager.show=false \
    -C "$REPO" "$@"
}

[[ -f "$REPO/package.json" &&
   -f "$REPO/package-lock.json" &&
   -f "$REPO/RELEASE_PROVENANCE.json" &&
   -f "$REPO/src/version.ts" ]] ||
  die "required version metadata is missing"

version_details="$(
  node - "$REPO" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const provenance = JSON.parse(
    fs.readFileSync(path.join(root, "RELEASE_PROVENANCE.json"), "utf8"),
  );
  const source = fs.readFileSync(path.join(root, "src/version.ts"), "utf8");
  const matches = [
    ...source.matchAll(
      /export\s+const\s+SERVER_VERSION\s*=\s*"([^"]+)"\s*;/g,
    ),
  ];
  const versions = [
    pkg.version,
    lock.version,
    lock.packages?.[""]?.version,
    provenance.custom_version,
    matches.length === 1 ? matches[0][1] : undefined,
  ];
  const names = [pkg.name, lock.name, lock.packages?.[""]?.name];
  if (
    versions.some((value) => typeof value !== "string") ||
    names.some((value) => typeof value !== "string")
  ) {
    process.exit(2);
  }
  process.stdout.write([...versions, ...names].join("\t"));
} catch {
  process.exit(3);
}
NODE
)" || die "version metadata could not be parsed exactly"

IFS=$'\t' read -r package_version lock_version lock_root_version provenance_version source_version \
  package_name lock_name lock_root_name <<< "$version_details"

[[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die "package version is not an exact stable semantic version"
[[ "$package_version" == "$lock_version" &&
   "$package_version" == "$lock_root_version" &&
   "$package_version" == "$provenance_version" &&
   "$package_version" == "$source_version" ]] ||
  die "package, lockfile, provenance, and source versions disagree"
[[ "$package_name" == "$lock_name" && "$package_name" == "$lock_root_name" ]] ||
  die "package and lockfile root names disagree"

dirty="$(
  LC_ALL=C safe_git status \
    --porcelain=v1 \
    --untracked-files=all \
    --ignore-submodules=none
)" || die "worktree cleanliness could not be determined"
[[ -z "$dirty" ]] ||
  die "tracked or non-ignored untracked release files are present"

# Git's ignore layers are not a trust boundary.  Disable global excludes above,
# reject active per-clone exclude rules, then enumerate every ignored entry and
# permit only the runtime/generated state needed for an idempotent bootstrap.
exclude_file="$(safe_git rev-parse --git-path info/exclude 2>/dev/null)" ||
  die "per-clone exclude path could not be resolved"
if [[ -f "$exclude_file" ]]; then
  while IFS= read -r exclude_line || [[ -n "$exclude_line" ]]; do
    case "$exclude_line" in
      ""|\#*) ;;
      *) die "active per-clone info/exclude rules are not allowed" ;;
    esac
  done < "$exclude_file"
fi

ignored_list="$(mktemp "${TMPDIR:-/tmp}/notebooklm-ignored.XXXXXX")"
if ! safe_git ls-files --others --ignored --exclude-standard -z > "$ignored_list"; then
  rm -f -- "$ignored_list"
  die "ignored worktree entries could not be enumerated"
fi
ignored_error=""
while IFS= read -r -d '' ignored_path; do
  case "$ignored_path" in
    .audio-roots.env)
      if [[ ! -f "$REPO/$ignored_path" || -L "$REPO/$ignored_path" ]]; then
        ignored_error="runtime environment state must be a regular non-symbolic file"
        break
      fi
      ;;
    node_modules/*)
      # npm ci removes and recreates this entire tree before any project build.
      # Its root must still be a real directory so cleanup cannot be redirected.
      if [[ ! -d "$REPO/node_modules" || -L "$REPO/node_modules" ]]; then
        ignored_error="node_modules must be a real directory before npm ci"
        break
      fi
      ;;
    dist/*)
      # tsc writes into dist without first removing it, so every existing
      # ignored output must be a regular file rather than a redirection.
      if [[ ! -f "$REPO/$ignored_path" || -L "$REPO/$ignored_path" ]]; then
        ignored_error="dist output must be a regular non-symbolic file: $ignored_path"
        break
      fi
      ;;
    *.tsbuildinfo)
      if [[ "$ignored_path" == */* ||
            ! -f "$REPO/$ignored_path" ||
            -L "$REPO/$ignored_path" ]]; then
        ignored_error="TypeScript build state must be a root regular non-symbolic file"
        break
      fi
      ;;
    *)
      ignored_error="ignored non-runtime worktree entry is present: $ignored_path"
      break
      ;;
  esac
done < "$ignored_list"
rm -f -- "$ignored_list"
[[ -z "$ignored_error" ]] || die "$ignored_error"

head_commit="$(safe_git rev-parse "HEAD^{commit}" 2>/dev/null)" ||
  die "HEAD is not a commit"
[[ "$head_commit" =~ ^[0-9a-f]{40}$ ]] || die "HEAD is not an exact commit"

release_tag="v$package_version"
local_tag_commit="$(safe_git rev-parse "refs/tags/$release_tag^{commit}" 2>/dev/null)" ||
  die "exact stable release tag is missing: $release_tag"
[[ "$local_tag_commit" == "$head_commit" ]] ||
  die "exact stable release tag does not point at HEAD: $release_tag"

remote_output="$(
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_TERMINAL_PROMPT=0 \
    git -c credential.helper= ls-remote "$PUBLIC_REPOSITORY" \
      refs/heads/main "refs/tags/$release_tag" "refs/tags/$release_tag^{}" 2>/dev/null
)" || die "public release refs could not be read"

public_main=""
public_tag=""
public_tag_peeled=""
while IFS=$'\t' read -r commit ref; do
  [[ -n "$commit" && -n "$ref" ]] || continue
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "public ref returned a non-commit object id"
  case "$ref" in
    refs/heads/main)
      [[ -z "$public_main" ]] || die "public main resolved more than once"
      public_main="$commit"
      ;;
    "refs/tags/$release_tag")
      [[ -z "$public_tag" ]] || die "public release tag resolved more than once"
      public_tag="$commit"
      ;;
    "refs/tags/$release_tag^{}")
      [[ -z "$public_tag_peeled" ]] || die "public peeled release tag resolved more than once"
      public_tag_peeled="$commit"
      ;;
    *) die "unexpected public ref returned: $ref" ;;
  esac
done <<< "$remote_output"

[[ "$public_main" == "$head_commit" ]] ||
  die "HEAD is not the commit published at main"
[[ -n "$public_tag" ]] || die "public stable release tag is missing: $release_tag"
if [[ -n "$public_tag_peeled" ]]; then
  [[ "$public_tag_peeled" == "$head_commit" ]] ||
    die "public annotated release tag does not peel to HEAD"
else
  [[ "$public_tag" == "$head_commit" ]] ||
    die "public lightweight release tag does not point at HEAD"
fi

echo "Install release verified: $release_tag at $head_commit"
