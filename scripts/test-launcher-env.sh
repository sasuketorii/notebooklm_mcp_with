#!/usr/bin/env bash
# Isolated integration test: both stdio and HTTP launchers must use their
# recorded absolute Node binary and export a space-containing audio root.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notebooklm-launcher-test.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT

ROOT="$TMP_DIR/custom checkout"
mkdir -p "$ROOT/scripts" "$ROOT/dist" "$ROOT/bin"
CANONICAL_ROOT="$(cd -- "$ROOT" && pwd -P)"
cp "$SCRIPT_DIR/mcp-launcher.sh" "$ROOT/scripts/mcp-launcher.sh"
cp "$SCRIPT_DIR/start-http.sh" "$ROOT/scripts/start-http.sh"
chmod +x "$ROOT/scripts/mcp-launcher.sh"
chmod +x "$ROOT/scripts/start-http.sh"

FAKE_NODE="$ROOT/bin/saved node"
cat > "$FAKE_NODE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n%s\n%s\n%s\n' "$0" "$NOTEBOOKLM_NODE_BIN" "$NOTEBOOKLM_AUDIO_ROOTS" "${NOTEBOOKLM_HTTP_BEARER_TOKEN-}"
printf '%s\n' "$@"
EOF
chmod +x "$FAKE_NODE"
touch "$ROOT/dist/index.js"
chmod +x "$ROOT/dist/index.js"

AUDIO_ROOT="$ROOT/audio files"
mkdir -p "$AUDIO_ROOT"
{
  printf 'NOTEBOOKLM_NODE_BIN=%q\n' "$FAKE_NODE"
  printf 'NOTEBOOKLM_AUDIO_ROOTS=%q\n' "$AUDIO_ROOT"
  printf 'NOTEBOOKLM_HTTP_BEARER_TOKEN=%q\n' 'launcher-test-token-012345678901234567890'
} > "$ROOT/.audio-roots.env"
chmod 600 "$ROOT/.audio-roots.env"

actual="$(env -i HOME="$TMP_DIR/home" PATH="/usr/bin:/bin" "$ROOT/scripts/mcp-launcher.sh")"
expected="$(printf '%s\n%s\n%s\n%s\n%s' "$FAKE_NODE" "$FAKE_NODE" "$AUDIO_ROOT" '' "$CANONICAL_ROOT/dist/index.js")"
[[ "$actual" == "$expected" ]] || {
  echo "stdio launcher did not preserve the configured Node binary and audio root" >&2
  exit 1
}

actual="$(env -i HOME="$TMP_DIR/home" PATH="/usr/bin:/bin" "$ROOT/scripts/start-http.sh")"
expected="$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s' "$FAKE_NODE" "$FAKE_NODE" "$AUDIO_ROOT" 'launcher-test-token-012345678901234567890' "$CANONICAL_ROOT/dist/index.js" --transport http --host 127.0.0.1 --port 3000)"
[[ "$actual" == "$expected" ]] || {
  echo "HTTP launcher did not preserve the configured Node binary, audio root, or arguments" >&2
  exit 1
}

# A non-empty ambient token must override the private env-file token.
ambient_token='ambient-launcher-token-012345678901234567890'
actual="$(env -i HOME="$TMP_DIR/home" PATH="/usr/bin:/bin" NOTEBOOKLM_HTTP_BEARER_TOKEN="$ambient_token" "$ROOT/scripts/start-http.sh")"
expected="$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s' "$FAKE_NODE" "$FAKE_NODE" "$AUDIO_ROOT" "$ambient_token" "$CANONICAL_ROOT/dist/index.js" --transport http --host 127.0.0.1 --port 3000)"
[[ "$actual" == "$expected" ]] || {
  echo "HTTP launcher did not give a non-empty ambient bearer token precedence" >&2
  exit 1
}

# Missing and short bearer tokens must fail closed before Node is exec'd.
cp -- "$ROOT/.audio-roots.env" "$ROOT/.audio-roots.env.saved"
printf 'NOTEBOOKLM_NODE_BIN=%q\nNOTEBOOKLM_AUDIO_ROOTS=%q\n' "$FAKE_NODE" "$AUDIO_ROOT" > "$ROOT/.audio-roots.env"
if env -i HOME="$TMP_DIR/home" PATH="/usr/bin:/bin" "$ROOT/scripts/start-http.sh" >/dev/null 2>&1; then
  echo "HTTP launcher accepted a missing bearer token" >&2
  exit 1
fi
printf 'NOTEBOOKLM_NODE_BIN=%q\nNOTEBOOKLM_AUDIO_ROOTS=%q\nNOTEBOOKLM_HTTP_BEARER_TOKEN=%q\n' "$FAKE_NODE" "$AUDIO_ROOT" short-token > "$ROOT/.audio-roots.env"
if env -i HOME="$TMP_DIR/home" PATH="/usr/bin:/bin" "$ROOT/scripts/start-http.sh" >/dev/null 2>&1; then
  echo "HTTP launcher accepted a short bearer token" >&2
  exit 1
fi
mv -- "$ROOT/.audio-roots.env.saved" "$ROOT/.audio-roots.env"
echo "stdio and HTTP launcher environment integration: PASS"
