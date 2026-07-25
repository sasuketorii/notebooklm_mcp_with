#!/usr/bin/env bash
# Shared, closed source-release file enumeration.

release_regular_files=(
  .gitignore
  .prettierignore
  .prettierrc.json
  AGENTS.md
  CHANGELOG.md
  CLAUDE.md
  CUSTOM_TOOL_CONTRACTS.json
  LICENSE
  README.md
  RELEASE_PROVENANCE.json
  SETUP_JA.md
  TRUSTED_RELEASES.json
  UPSTREAM_BASELINE.json
  eslint.config.js
  package-lock.json
  package.json
  tsconfig.json
)

release_directories=(
  .github
  docs
  scripts
  src
)

release_validate_root() {
  local root="$1"
  [[ -n "$root" ]] || {
    echo "Release root must not be empty" >&2
    return 1
  }
  [[ ! -L "$root" && -d "$root" ]] || {
    echo "Release root must be a real directory, not a symlink: $root" >&2
    return 1
  }
}

# Writes a sorted, NUL-delimited list of release-relative regular files.
# Every configured root entry must exist with its declared type. Symlinks,
# FIFOs, sockets, devices, and find traversal failures are rejected.
release_collect_files() {
  local root="$1" output="$2"
  local relative directory scan_file
  local -a scan_files=()

  release_validate_root "$root" || return 1
  [[ -n "$output" ]] || {
    echo "Release file-list output must not be empty" >&2
    return 1
  }

  : >"$output" || return 1
  for relative in "${release_regular_files[@]}"; do
    [[ -f "$root/$relative" && ! -L "$root/$relative" ]] || {
      echo "Release entry must be a regular file, not a symlink: $relative" >&2
      return 1
    }
    printf '%s\0' "$relative" >>"$output" || return 1
  done

  for directory in "${release_directories[@]}"; do
    [[ -d "$root/$directory" && ! -L "$root/$directory" ]] || {
      echo "Release entry must be a directory, not a symlink: $directory" >&2
      return 1
    }
    scan_file="$(mktemp "${TMPDIR:-/tmp}/notebooklm-release-find.XXXXXX")" || return 1
    scan_files+=("$scan_file")
    if ! find "$root/$directory" -mindepth 1 -print0 >"$scan_file"; then
      /bin/rm -f -- "${scan_files[@]}"
      echo "Failed to enumerate release directory: $directory" >&2
      return 1
    fi
    while IFS= read -r -d '' relative; do
      if [[ -d "$relative" && ! -L "$relative" ]]; then
        continue
      fi
      if [[ ! -f "$relative" || -L "$relative" ]]; then
        /bin/rm -f -- "${scan_files[@]}"
        echo "Release directory contains a symlink or non-regular entry: $directory" >&2
        return 1
      fi
      relative="${relative#"$root/"}"
      case "$relative" in
        ""|/*|../*|*/../*|*/..|*\\*|*$'\n'*|*$'\r'*)
          /bin/rm -f -- "${scan_files[@]}"
          echo "Unsafe release path: $relative" >&2
          return 1
          ;;
      esac
      printf '%s\0' "$relative" >>"$output" || {
        /bin/rm -f -- "${scan_files[@]}"
        return 1
      }
    done <"$scan_file"
  done

  /bin/rm -f -- "${scan_files[@]}"
  LC_ALL=C sort -zu -o "$output" "$output"
}
