# Tools

Every tool registered in custom version 0.0.6, with parameter schema, examples, return envelopes, bounds, and readiness/provenance caveats.

The server returns each tool result wrapped as `{ "success": true, "data": <object> }` (or `{ "success": false, "error": <string> }`). The shapes below describe the inner `data`.

---

## ask_question

Ask a question against a notebook. Reuses an existing browser session when `session_id` is supplied. Citation extraction reads the DOM citation panel after the answer settles.

**v2 additions**: `source_format`, `_provenance` envelope on the result, AI-generated answer prefix.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | The question to ask. |
| `session_id` | string | no | Reuse an existing session for context. Omit to create a new one. |
| `notebook_id` | string | no | Library notebook ID. Falls back to active notebook. |
| `notebook_url` | string | no | Direct NotebookLM URL. If `notebook_id` is also supplied, both must resolve to the same known notebook; unknown or mismatched targets fail closed. |
| `source_format` | `none` \| `inline` \| `footnotes` \| `json` | no | Citation rendering. Default `none`. |
| `show_browser` | bool | no | Shorthand for `browser_options.show`. |
| `browser_options` | object | no | Per-call browser overrides — see [`docs/configuration.md`](./configuration.md#per-call-browser-options). |

### Example

```json
{
  "name": "ask_question",
  "arguments": {
    "question": "How does the OAuth refresh token rotation work?",
    "notebook_id": "auth-notebook",
    "source_format": "footnotes"
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "question": "How does the OAuth refresh token rotation work?",
  "answer": "[AI-GENERATED ...] The refresh token is rotated each ...\n\nSources:\n[1] auth-spec.pdf — ...",
  "session_id": "ses_…",
  "notebook_url": "https://notebooklm.google.com/notebook/…",
  "session_info": {
    "age_seconds": 12,
    "message_count": 3,
    "last_activity": "2026-04-30T12:00:00.000Z"
  },
  "_provenance": {
    "provider": "google-notebooklm",
    "model": "gemini-2.5",
    "via": "chrome-automation",
    "grounding": "user-uploaded-documents",
    "ai_generated": true
  },
  "source_format": "footnotes",
  "sources": [
    { "index": 1, "title": "auth-spec.pdf", "excerpt": "Refresh tokens MUST be rotated…" }
  ]
}
```

`sources` is omitted when `source_format=none` or when no citations were found.

---

## add_source — new in v2

Add a source to a notebook. v2 supports `type=url` (web crawl) and `type=text` (paste). `add_source` itself does **not** upload local files; use `add_audio_source` for local audio or `add_youtube_source` for YouTube. Google Drive and general file uploads remain unsupported.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `type` | `url` \| `text` | yes | |
| `content` | string | yes | URL when `type=url`, raw text when `type=text`. |
| `title` | string | no | Optional display title. NotebookLM picks a default. |
| `session_id` | string | no | Reuse an existing browser session. |
| `notebook_id` | string | no | Library notebook ID. |
| `notebook_url` | string | no | Direct NotebookLM URL. If `notebook_id` is also supplied, both must resolve to the same known notebook; unknown or mismatched targets fail closed. |

### Example

```json
{
  "name": "add_source",
  "arguments": {
    "type": "url",
    "content": "https://docs.n8n.io/code/builtin/json-jmespath/",
    "title": "n8n JMESPath builtin"
  }
}
```

---

### Wire response

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "success": true,
      "type": "url",
      "sourceCountBefore": 12,
      "sourceCountAfter": 13,
      "sourceNames": ["n8n JMESPath builtin"]
    }
  }
}
```

---

## add_youtube_source — custom fork

Register one public YouTube watch/shorts video through NotebookLM's source UI.
The response verifies that a source-list row appeared, but does **not** claim
that NotebookLM has finished indexing or generated a transcript. Use the
returned `sourceNames` with `wait_for_source_ready` before asking questions.

| Name | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | HTTPS `youtube.com/watch?v=…`, `youtu.be/…`, or `/shorts/…`; max 2048 chars. |
| `timeout_ms` | integer | no | 1,000–1,200,000 ms; default 120,000. |
| `session_id` / `notebook_id` / `notebook_url` | string | no | Shared targeting. If both notebook fields are supplied, they must resolve to the same known notebook; unknown or mismatched targets fail closed. |
| `show_browser` | bool | no | Show browser while adding; default `false`. |

```json
{
  "name": "add_youtube_source",
  "arguments": {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "notebook_id": "research-notebook"
  }
}
```

`data.result` contains `status` (`CONFIRMED`, `INDETERMINATE`, or `FAILED`),
canonical `url`, before/after source counts, `sourceNames`,
`verifiedSourceRows`, `identityConfidence`, and an optional `message`.
`INDETERMINATE` means submission happened but row identity was not proven;
do not automatically retry because the source may already exist.

## wait_for_source_ready — custom fork

Poll the visible NotebookLM source list until every exact title has stable,
positive UI readiness evidence. This is a UI-state check only; it does not
verify transcript completeness or media correctness.

| Name | Type | Required | Notes |
|---|---|---|---|
| `source_names` | string[] | yes | 1–10 exact source-list titles, unique, max 300 chars each. |
| `timeout_ms` | integer | no | 1–600,000 ms; default 90,000. |
| `poll_interval_ms` | integer | no | 50–30,000 ms; default 1,000. |
| `stable_polls` | integer | no | 1–20 consecutive ready probes; default 2. |
| `session_id` / `notebook_id` / `notebook_url` / `show_browser` | mixed | no | Shared targeting and browser visibility. |

```json
{
  "name": "wait_for_source_ready",
  "arguments": {
    "source_names": ["Never Gonna Give You Up — Rick Astley"],
    "timeout_ms": 120000
  }
}
```

The result reports `status`/`overall` (`ready`, `processing`, `error`,
`not_found`, or `timeout`), one item per requested source with `name`, status,
and evidence, plus a limitation stating that this is UI readiness only.

## export_transcript — custom fork

Open one exact source title in NotebookLM's source viewer and extract the text
rendered by that UI. This is direct-UI extraction, not a model-claimed answer;
it is **not independently verified** against the original video/audio and may
be partial when the viewer cannot settle. Partial/indeterminate results are
marked in the returned completeness and warnings; do not present them as a
verified verbatim media transcript.

| Name | Type | Required | Notes |
|---|---|---|---|
| `source_name` | string | yes | Exact visible source-list title, max 300 chars. |
| `format` | `markdown` \| `json` | no | Output serialization; default `markdown`. |
| `output_name` | string | no | Safe filename stem (`A-Z`, digits, `.`, `_`, `-`); no path separators. |
| `max_chars` | integer | no | 1–1,000,000 retained chars; default 1,000,000. |
| `timeout_ms` | integer | no | 30,000–1,800,000 ms; default 120,000. |
| `session_id` / `notebook_id` / `notebook_url` / `show_browser` | mixed | no | Shared targeting and browser visibility. |

```json
{
  "name": "export_transcript",
  "arguments": {
    "source_name": "Never Gonna Give You Up — Rick Astley",
    "format": "json",
    "output_name": "rick-astley-transcript"
  }
}
```

The result includes the saved path/format/byte and SHA-256 receipt (when an
output file is requested), transcript `text`, chunk hashes and markers,
`completeness` (`ui_extracted`, `complete_claimed`, `partial`, or
`indeterminate`), warnings, and provenance. Provenance explicitly reports
`generatedByAI: null`, `verification: "ui_extracted_not_independently_verified"`,
and exact-title source isolation. The outer result also sets `completed` only
for `ui_extracted` and always sets `verifiedComplete: false`.

---

## add_audio_source — custom fork

Upload one or more local audio files through NotebookLM's own file chooser.
The tool validates canonical regular-file paths before browser interaction and
returns source-panel verification plus SHA-256/byte receipts. It does not
transcribe audio or send it to an external ASR provider.
The `<audio-root>` token in the example is a portable placeholder; replace it
with an existing, resolvable absolute audio directory on the host.

| Name | Type | Required | Notes |
|---|---|---|---|
| `file_paths` | string[] | yes | 1–10 paths; `.mp3`, `.m4a`, `.aac`, `.wav`, `.flac`, `.ogg`, `.opus`; 200 MiB/file and 500 MiB total safety limits. |
| `notebook_id` | string | no | Library notebook ID. |
| `notebook_url` | string | no | Direct NotebookLM URL. If `notebook_id` is also supplied, both must resolve to the same known notebook; unknown or mismatched targets fail closed. |
| `session_id` | string | no | Reuse a browser session. |
| `show_browser` | bool | no | Show the browser while debugging. |
| `timeout_ms` | integer | no | Source-panel confirmation wait in milliseconds. Default `900000`; allowed `30000`–`1200000`. |

```json
{
  "name": "add_audio_source",
  "arguments": {
    "file_paths": ["<audio-root>/episode.mp3"],
    "notebook_url": "https://notebooklm.google.com/notebook/<uuid>"
  }
}
```

The inner `data.result` contains `status` (`CONFIRMED`, `INDETERMINATE`, or `FAILED`),
`sourceCountBefore`, `sourceCountAfter`, expected and verified source names,
plus per-file `sha256` and `bytes`. `success: true` with `status: "CONFIRMED"`
means every requested filename was visible in the NotebookLM source panel.
`INDETERMINATE` means the browser upload was initiated but confirmation was not
obtained; do **not** retry automatically, because the source may already have
been added. NotebookLM's later indexing remains asynchronous.

---

## generate_audio — new in v2

Generate a podcast-style Audio Overview for a notebook. The default is async:
it returns `started`, `in_progress`, or `ready` without waiting. Use
`get_audio_status` about every 30 seconds; when it returns `ready`, call
`download_audio`. Set `wait_for_completion=true` only when the caller should
block until ready (or `timeout_ms` is reached).

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `custom_prompt` | string | no | Optional focus prompt. |
| `timeout_ms` | number | no | Wait ceiling. Default `600000`. |
| `wait_for_completion` | bool | no | Default `false`. When true, block until `ready` or the timeout. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "generate_audio",
  "arguments": {
    "custom_prompt": "Focus on the migration strategy",
    "timeout_ms": 900000
  }
}
```

### Inner `data` payload

```jsonc
{
  "result": {
    "status": "started",
    "message": "Audio Overview generation started. Poll get_audio_status, then download_audio."
  }
}
```

Possible `result.status` values are `started`, `in_progress`, `ready`, and
`error`. Pair with `get_audio_status` then `download_audio` to persist the
file. Video / Infographic / Slides, Drive, PDF/DOCX/image uploads, and non-audio Studio artifacts are unsupported.

---

## get_audio_status

Non-blocking probe for the current Audio Overview. Poll about every 30 seconds
after `generate_audio`; when `result.status` is `ready`, call `download_audio`.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |
| `show_browser` | bool | no | Show the browser while debugging. |

### Inner `data` payload

```jsonc
{
  "result": {
    "status": "in_progress",
    "message": "Audio Overview is still being generated."
  }
}
```

Possible `result.status` values are `not_started`, `in_progress`, `ready`, and
`error`.

---

## download_audio — new in v2

Download the most recent Audio Overview to disk.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `destination_dir` | string | yes | Absolute directory. Created if missing. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "download_audio",
  "arguments": {
    "destination_dir": "$HOME/Downloads/notebooklm"
  }
}
```

### Inner `data` payload

```jsonc
{
  "result": {
    "success": true,
  "filePath": "$HOME/Downloads/notebooklm/overview-2026-04-30.m4a"
  }
}
```

Run `generate_audio` first if no Audio Overview exists yet.

---

## add_notebook

Add a NotebookLM share-URL to the local library. The tool description enforces a confirmation workflow on the host agent — do not call without explicit user consent.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | NotebookLM share URL. |
| `name` | string | yes | Display name. |
| `description` | string | yes | Short description of the notebook content. |
| `topics` | string[] | yes | Topics covered. |
| `content_types` | string[] | no | e.g. `["documentation", "examples"]`. |
| `use_cases` | string[] | no | When to consult this notebook. |
| `tags` | string[] | no | Optional organizational tags. |

### Return shape

```jsonc
{
  "status": "added",
  "id": "nb_abcd",
  "name": "n8n Documentation",
  "active": true
}
```

---

## list_notebooks

No parameters. Returns the full library.

### Return shape

```jsonc
{
  "active_notebook_id": "nb_abcd",
  "notebooks": [
    {
      "id": "nb_abcd",
      "name": "n8n Documentation",
      "url": "https://notebooklm.google.com/notebook/…",
      "description": "n8n core + builtin nodes",
      "topics": ["workflow automation", "n8n"],
      "use_cases": ["building n8n workflows"],
      "tags": ["docs"],
      "use_count": 42
    }
  ]
}
```

---

## get_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

Returns one entry from `list_notebooks`.

---

## select_notebook

Set a notebook as the active default.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

### Return shape

```jsonc
{ "status": "active", "id": "nb_abcd", "name": "n8n Documentation" }
```

---

## update_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |
| `name` | string | no |
| `description` | string | no |
| `topics` | string[] | no |
| `content_types` | string[] | no |
| `use_cases` | string[] | no |
| `tags` | string[] | no |
| `url` | string | no |

Returns the updated entry.

---

## remove_notebook

Removes the entry from the local library only — does not delete the notebook in NotebookLM.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

---

## search_notebooks

Searches name, description, topics, tags.

| Name | Type | Required |
|---|---|---|
| `query` | string | yes |

Returns an array of matching entries.

---

## get_library_stats

No parameters. Returns total notebooks, total queries, top-used notebooks.

---

## list_sessions

No parameters. Returns active sessions with age, message count, last-activity timestamp.

---

## close_session

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## reset_session

Clears chat history while keeping the same `session_id`.

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## get_health

No parameters.

### Return shape

```jsonc
{
  "status": "ok",
  "authenticated": true,
  "auth_status": "runtime_verified",
  "auth_evidence": "live_notebooklm_readiness",
  "notebook_url": "https://notebooklm.google.com/notebook/...",
  "active_notebook_id": "example",
  "active_notebook_name": "Example",
  "total_notebooks": 1,
  "active_sessions": 1,
  "max_sessions": 10,
  "session_timeout": 900,
  "total_messages": 3,
  "headless": true,
  "auto_login_enabled": false,
  "stealth_enabled": true
}
```

`auth_status` has this exact offline classification:

| Status | `authenticated` | Evidence |
|---|---:|---|
| `runtime_verified` | true | This process completed a live NotebookLM readiness check. |
| `snapshot_usable` | true | Snapshot has unexpired persistent critical-cookie evidence. Google acceptance is not verified. |
| `snapshot_indeterminate` | false | Session-only evidence can bootstrap an isolated browser but is not durable proof. |
| `snapshot_missing` | false | No safe snapshot file. |
| `snapshot_malformed` | false | Snapshot failed schema, size, ownership, mode, or no-follow checks. |
| `snapshot_expired` | false | Only expired critical-cookie evidence remains. |
| `not_authenticated` | false | No recognized authentication evidence. |

When `authenticated=false` the response also carries a non-destructive
`troubleshooting_tip`. `get_health` never launches a browser or contacts Google.

---

## setup_auth

Opens a visible Chrome for first-time Google login.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true` for setup. |
| `browser_options` | object | no | Same shape as `ask_question`. |

Waits for the user to complete login for up to 10 minutes. Existing persistent
profile/state is preserved; a conflicting process receives `profile_busy`.
Verify with `get_health` afterwards.

---

## re_auth

Unavailable. It returns `re_auth_unavailable` without opening a browser,
changing configuration, rotating accounts, or touching authentication files.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Compatibility argument accepted but ignored. |
| `browser_options` | object | no | Compatibility argument accepted but ignored. |

---

## cleanup_data

Categorised, non-mutating preview of NotebookLM MCP files. Destructive cleanup
is unavailable.

| Name | Type | Required | Notes |
|---|---|---|---|
| `confirm` | bool | yes | `false` = preview only. `true` = `cleanup_unavailable` with no side effects. |
| `preserve_library` | bool | no | `true` filters library-related paths out of the hypothetical preview. It never deletes files. |

Workflow:

1. `cleanup_data({ confirm: false, preserve_library: true })` — inspect hypothetical non-library paths.
2. Use the preview to diagnose storage; it does not delete anything.

---

## Resources (read-only)

| URI | Purpose |
|---|---|
| `notebooklm://library` | JSON view of the full library. |
| `notebooklm://library/{id}` | One notebook by ID. The `{id}` template autocompletes from the library. |
| `notebooklm://metadata` | Deprecated. Use `notebooklm://library` instead. |

The MCP server does not respond to `mcp://notebooklm` — that URI scheme never existed. Use `notebooklm://`.
