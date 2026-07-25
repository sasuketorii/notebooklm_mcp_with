#!/usr/bin/env bash
# Strict parser for the private launcher environment.
#
# This file may be sourced by trusted launchers.  It never sources or evaluates
# the data file: values after the first "=" are copied literally after the
# file, key, and value contracts have been validated.

private_env_error() {
  printf 'Invalid private environment: %s\n' "$*" >&2
  return 1
}

private_env_stat() {
  local field="$1" path="$2"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    case "$field" in
      uid) stat -f '%u' "$path" ;;
      mode) stat -f '%Lp' "$path" ;;
      size) stat -f '%z' "$path" ;;
      identity) stat -f '%d:%i' "$path" ;;
    esac
  else
    case "$field" in
      uid) stat -c '%u' "$path" ;;
      mode) stat -c '%a' "$path" ;;
      size) stat -c '%s' "$path" ;;
      identity) stat -c '%d:%i' "$path" ;;
    esac
  fi
}

private_env_fd_stat() {
  [[ -x /usr/bin/perl ]] ||
    private_env_error "/usr/bin/perl is required for secure open-file validation" || return 1
  /usr/bin/perl -e '
    my @s = stat(STDIN);
    exit 2 unless @s;
    printf "%s:%s:%s:%o:%s", $s[0], $s[1], $s[4], $s[2] & 0777, $s[7];
  ' <&9
}

private_env_open_error() {
  exec 9<&-
  private_env_error "$*"
}

private_env_load() {
  local file="$1" line key value
  local seen_node=false seen_roots=false seen_token=false
  local _device _inode owner mode size canonical root rest opened before after path_identity

  [[ -e "$file" ]] || private_env_error "missing file: $file" || return 1
  [[ ! -L "$file" ]] || private_env_error "symbolic links are forbidden: $file" || return 1
  [[ -f "$file" ]] || private_env_error "not a regular file: $file" || return 1
  exec 9< "$file" || private_env_error "could not open file" || return 1
  before="$(private_env_fd_stat)" ||
    { private_env_open_error "could not inspect the open file"; return 1; }
  IFS=: read -r _device _inode owner mode size <<< "$before"
  [[ "$owner" == "$(id -u)" ]] ||
    { private_env_open_error "file owner does not match the current user"; return 1; }
  [[ "$mode" == 600 ]] ||
    { private_env_open_error "file mode must be exactly 600 (found $mode)"; return 1; }
  (( size > 0 && size <= 65536 )) ||
    { private_env_open_error "file size must be between 1 and 65536 bytes"; return 1; }
  [[ ! -L "$file" ]] ||
    { private_env_open_error "file changed to a symbolic link"; return 1; }
  path_identity="$(private_env_stat identity "$file")" || { exec 9<&-; return 1; }
  opened="${_device}:${_inode}"
  [[ "$path_identity" == "$opened" ]] ||
    { private_env_open_error "file identity changed while opening"; return 1; }

  NOTEBOOKLM_NODE_BIN=""
  NOTEBOOKLM_AUDIO_ROOTS=""
  NOTEBOOKLM_HTTP_BEARER_TOKEN=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || { private_env_open_error "blank lines are forbidden"; return 1; }
    [[ "$line" == *=* ]] || { private_env_open_error "line has no equals sign"; return 1; }
    key="${line%%=*}"
    value="${line#*=}"
    [[ -n "$value" ]] || { private_env_open_error "$key has an empty value"; return 1; }
    [[ ! "$value" =~ [[:cntrl:]] ]] ||
      { private_env_open_error "$key contains a control character"; return 1; }
    case "$key" in
      NOTEBOOKLM_NODE_BIN)
        ! "$seen_node" || { private_env_open_error "duplicate key: $key"; return 1; }
        seen_node=true
        NOTEBOOKLM_NODE_BIN="$value"
        ;;
      NOTEBOOKLM_AUDIO_ROOTS)
        ! "$seen_roots" || { private_env_open_error "duplicate key: $key"; return 1; }
        seen_roots=true
        NOTEBOOKLM_AUDIO_ROOTS="$value"
        ;;
      NOTEBOOKLM_HTTP_BEARER_TOKEN)
        ! "$seen_token" || { private_env_open_error "duplicate key: $key"; return 1; }
        seen_token=true
        NOTEBOOKLM_HTTP_BEARER_TOKEN="$value"
        ;;
      *) private_env_open_error "unsupported key: $key"; return 1 ;;
    esac
  done <&9
  after="$(private_env_fd_stat)" ||
    { private_env_open_error "could not re-inspect the open file"; return 1; }
  exec 9<&-
  [[ "$after" == "$before" && ! -L "$file" &&
     "$(private_env_stat identity "$file")" == "$opened" ]] ||
    private_env_error "file changed while it was being parsed" || return 1

  "$seen_node" && "$seen_roots" ||
    private_env_error "Node and audio-root keys are required" || return 1
  [[ "$NOTEBOOKLM_NODE_BIN" == /* && -f "$NOTEBOOKLM_NODE_BIN" && -x "$NOTEBOOKLM_NODE_BIN" ]] ||
    private_env_error "NOTEBOOKLM_NODE_BIN must be an absolute executable file" || return 1

  rest="$NOTEBOOKLM_AUDIO_ROOTS"
  while :; do
    if [[ "$rest" == *:* ]]; then
      root="${rest%%:*}"
      rest="${rest#*:}"
    else
      root="$rest"
      rest=""
    fi
    [[ "$root" == /* && -d "$root" ]] ||
      private_env_error "each audio root must be an absolute existing directory" || return 1
    canonical="$(cd -- "$root" && pwd -P)" || return 1
    [[ "$canonical" == "$root" ]] ||
      private_env_error "audio roots must already be canonical paths" || return 1
    [[ -n "$rest" ]] || break
  done
  if "$seen_token"; then
    [[ ${#NOTEBOOKLM_HTTP_BEARER_TOKEN} -ge 32 && ${#NOTEBOOKLM_HTTP_BEARER_TOKEN} -le 512 ]] ||
      private_env_error "bearer token length must be between 32 and 512 bytes" || return 1
    [[ "$NOTEBOOKLM_HTTP_BEARER_TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]] ||
      private_env_error "bearer token contains unsupported characters" || return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "This parser is a library and must be sourced by a trusted launcher." >&2
  exit 2
fi
