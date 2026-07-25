# Usage Guide

Practical end-to-end walkthroughs for custom version 0.0.5. Each section is a self-contained recipe with the exact tool calls / curl commands. The upstream base is recorded in `RELEASE_PROVENANCE.json`.

- [First-time setup](#first-time-setup)
- [Multi-turn session pattern](#multi-turn-session-pattern)
- [Citations workflow](#citations-workflow)
- [Audio Overview generation + download](#audio-overview-generation--download)
- [Multi-account switching](#multi-account-switching)
- [HTTP transport for n8n / Zapier](#http-transport-for-n8n--zapier)

---

## First-time setup

### 1. Install and start

Give the checkout URL to Codex or Claude Code and use the supported one-prompt bootstrap:

```bash
./scripts/bootstrap.sh --auto
```

Wire it into your MCP client of choice (see the [README](../README.md#install-and-register)).

### 2. Authenticate

Call `setup_auth`. A Chrome window opens. Log in to the Google account that owns the NotebookLM notebooks you want to query. Close the browser when done.

```json
{ "name": "setup_auth", "arguments": { "show_browser": true } }
```

Verify:

```json
{ "name": "get_health", "arguments": {} }
```

Immediately after setup, expect `auth_status: "snapshot_usable"` when the
saved state contains unexpired persistent-cookie evidence. After a successful
NotebookLM operation in the same process, expect `runtime_verified`.
`authenticated=true` is evidence, not a guarantee that Google will accept the
next request.

### 3. Add a notebook to the local library

Get a NotebookLM share-URL: open the notebook in `notebooklm.google.com`, click _Share → Anyone with the link → Copy link_. Then:

```json
{
  "name": "add_notebook",
  "arguments": {
    "url": "https://notebooklm.google.com/notebook/abcd-efgh",
    "name": "n8n Documentation",
    "description": "n8n core docs + builtin nodes",
    "topics": ["workflow automation", "n8n", "node configuration"],
    "use_cases": ["building n8n workflows", "debugging n8n executions"],
    "tags": ["docs", "n8n"]
  }
}
```

### 4. Ask the first question

```json
{
  "name": "ask_question",
  "arguments": {
    "question": "What is the recommended retry pattern for the HTTP Request node?"
  }
}
```

Capture `session_id` from the response — you will reuse it for follow-ups.

---

## Multi-turn session pattern

Reusing `session_id` keeps NotebookLM's conversational context. The browser session also stays open, so each follow-up is faster.

```json
// 1. Open broad — captures session_id
{ "name": "ask_question", "arguments": {
  "question": "Give me an overview of the n8n error handling architecture."
}}
// → response.session_id = "ses_abc123"

// 2. Drill in
{ "name": "ask_question", "arguments": {
  "question": "What's the recommended retry/backoff pattern for HTTP nodes?",
  "session_id": "ses_abc123"
}}

// 3. Edge cases
{ "name": "ask_question", "arguments": {
  "question": "Common pitfalls when retrying webhook-triggered workflows?",
  "session_id": "ses_abc123"
}}

// 4. Production sample
{ "name": "ask_question", "arguments": {
  "question": "Show me a production example combining retry + circuit-breaker.",
  "session_id": "ses_abc123"
}}
```

When the task changes, either:

- Reset the same session: `{ "name": "reset_session", "arguments": { "session_id": "ses_abc123" } }`
- Close it: `{ "name": "close_session", "arguments": { "session_id": "ses_abc123" } }` — and start a new one with no `session_id`.

Sessions auto-expire after `SESSION_TIMEOUT` seconds of inactivity (default `900` = 15 min).

---

## Citations workflow

Set `source_format` on `ask_question`. Four modes:

### `none` (default)

Raw answer. No `sources` field.

### `inline`

```json
{ "name": "ask_question", "arguments": {
  "question": "How does refresh-token rotation work?",
  "source_format": "inline"
}}
```

`[1]` markers in the answer text get replaced with `(source name — short excerpt)` inline.

### `footnotes`

```json
{ "name": "ask_question", "arguments": {
  "question": "How does refresh-token rotation work?",
  "source_format": "footnotes"
}}
```

Response (abridged):

```jsonc
{
  "answer": "[AI-GENERATED ...] Refresh tokens are rotated on every refresh request [1]. The previous token is revoked server-side [2].\n\nSources:\n[1] auth-spec.pdf — \"Refresh tokens MUST be rotated…\"\n[2] auth-spec.pdf — \"On rotation, the previous token MUST be invalidated…\"",
  "sources": [
    { "index": 1, "title": "auth-spec.pdf", "excerpt": "Refresh tokens MUST be rotated…" },
    { "index": 2, "title": "auth-spec.pdf", "excerpt": "On rotation, the previous token MUST be invalidated…" }
  ],
  "source_format": "footnotes"
}
```

### `json`

Answer text is left untouched. Citations are returned only as a structured array on `sources`. Use this when you want to render citations yourself.

---

## Audio Overview generation + download

Two-step workflow.

### 1. Generate

```json
{
  "name": "generate_audio",
  "arguments": {
    "custom_prompt": "Focus on the migration steps and breaking changes",
    "timeout_ms": 900000
  }
}
```

Generation can take several minutes — keep `timeout_ms` generous. The default is 600 000 ms (10 min).

### 2. Download

```json
{
  "name": "download_audio",
  "arguments": {
    "destination_dir": "$HOME/Downloads/notebooklm"
  }
}
```

Result includes the absolute `file_path` and size in bytes.

If you call `download_audio` before any Audio Overview has been generated, the call returns an error pointing at `generate_audio`. Run them in order, in the same notebook.

---

## Multi-account switching

Run two parallel installations against different Google accounts:

```bash
# Terminal A: work account
NOTEBOOKLM_ACCOUNT=work ./scripts/mcp-launcher.sh

# Terminal B: personal account
NOTEBOOKLM_ACCOUNT=personal ./scripts/mcp-launcher.sh
```

Each account gets its own Chrome profile under `<dataDir>/accounts/<name>/`. The first run for a new account requires its own `setup_auth`. Switching is a matter of starting the launcher with a different `NOTEBOOKLM_ACCOUNT` value.

Use cases:

- Working notebooks on a corporate Google account, side-projects on a personal one.
- Rotating between two free-tier accounts to extend the daily quota.

There is no shared library between accounts — each account has its own `library.json`. If you want the same library across accounts, copy `library.json` between the two `accounts/<name>/` directories manually.

---

## HTTP transport for n8n / Zapier

Start the server in HTTP mode:

```bash
# Generate a fresh local token (or load it from your secret manager) before
# starting the local custom server. Do not commit or reuse this value.
export NOTEBOOKLM_HTTP_BEARER_TOKEN="$(openssl rand -hex 32)"
./scripts/start-http.sh
```

The two operations:

| Method | Path |
|---|---|
| `POST` | `/mcp` |
| `GET` | `/healthz` |

### 1. Initialize a session

```bash
curl -i -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${NOTEBOOKLM_HTTP_BEARER_TOKEN}" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0.0.1" }
    }
  }'
```

Capture the `Mcp-Session-Id` response header. Pass it as a request header on every subsequent call.

### 2. Ask a question

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${NOTEBOOKLM_HTTP_BEARER_TOKEN}" \
  -H 'Mcp-Session-Id: <session-id-from-step-1>' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "ask_question",
      "arguments": {
        "question": "What is the n8n Code node best for?",
        "source_format": "footnotes"
      }
    }
  }'
```

The response is the standard MCP `tools/call` envelope. The actual tool output lives under `result.content[0].text` as a JSON string.

### Liveness probe

```bash
curl http://localhost:3000/healthz
# {"status":"ok","protocol":"mcp-streamable-http"}
```

### Notes

- The custom server binds only to loopback. For remote n8n/Zapier access, use a TLS-terminating reverse proxy or Tailscale tunnel as the external boundary.
- Sessions are kept in process memory; restarting the server invalidates all sessions.
- For n8n, Zapier, and similar HTTP-only callers, an "HTTP Request" node configured with a per-execution session-id store is enough — initialize once at workflow start, reuse the session for the rest of the run, and let the `DELETE /mcp` route close it cleanly at the end.
