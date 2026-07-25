# Troubleshooting

A symptom → fix matrix for custom version 0.0.2. For the full env-var inventory, see [`configuration.md`](./configuration.md). The upstream base is recorded in `RELEASE_PROVENANCE.json`.

## Chrome fails to launch (macOS Tahoe / Windows exit 21)

Symptom: `Failed to launch chrome`, `chrome exited immediately`, `code 21`, `executable doesn't exist`.

Cause: System Chrome on macOS 26 (Tahoe) and certain Windows 11 setups crashes on the persistent profile launch.

Fix: Force the bundled Patchright Chromium.

```bash
NOTEBOOKLM_BROWSER_CHANNEL=chromium ./scripts/mcp-launcher.sh
# or
BROWSER_CHANNEL=chromium ./scripts/mcp-launcher.sh
```

The fallback is also auto-applied when launch errors match the known patterns, but setting the env var explicitly makes the choice deterministic.

## `ask_question` times out

Symptom: The tool fails after roughly 10 min with a timeout error.

Checks:

1. Confirm the answer wait is sufficient — long-form prompts on notebooks with many sources legitimately exceed 2 min.
   ```bash
   ANSWER_TIMEOUT_MS=900000 ./scripts/mcp-launcher.sh   # 15 minutes
   ```
   Or per-call: `browser_options.timeout_ms`.
2. Run with a visible browser to see what NotebookLM is doing:
   ```json
   { "name": "ask_question", "arguments": { "question": "...", "show_browser": true } }
   ```
   Or start the server with `HEADLESS=false`.
3. Check `get_health`. `runtime_verified` means this process reached a ready
   NotebookLM page. Snapshot statuses are offline evidence only and do not
   inspect the current page.

## Session expired / repeated login prompts

Symptom: NotebookLM keeps redirecting to the login screen, or `get_health` reports `authenticated=false` after a previously successful login.

Workflow:

1. Close every Chrome / Chromium instance the user has open. An open Chrome can hold the persistent profile lock.
2. Run `setup_auth` to authenticate the persistent profile again.
3. Inspect storage with `cleanup_data` (it is preview-only):
   ```json
   { "name": "cleanup_data", "arguments": { "confirm": false, "preserve_library": true } }
   ```
   Then retry `setup_auth`; `re_auth` does not rotate or wipe accounts.

## WSL1

Symptom: Chrome refuses to launch under WSL1.

Fix: Upgrade to WSL2.

```powershell
wsl --set-default-version 2
wsl --set-version <distro> 2
```

WSL2 with WSLg (Windows 11 / Windows 10 22H2+) supports a real Chromium and works out of the box.

## Headless Linux server

Symptom: `setup_auth` fails on a server with no display because the login window cannot open.

Fix: Run the one-time setup under `xvfb-run`. After login the persistent Chrome profile lets every subsequent run go fully headless.

```bash
xvfb-run -a ./scripts/mcp-launcher.sh
# call setup_auth from your client, complete login, then exit
# from then on, run normally:
./scripts/mcp-launcher.sh
```

## "Unknown resource: mcp://notebooklm"

Cause: A client used the wrong URI scheme.

Fix: The scheme is `notebooklm://`, not `mcp://`. Supported URIs:

- `notebooklm://library`
- `notebooklm://library/{id}`
- `notebooklm://metadata` (deprecated)

The error message in v2 lists the correct set.

## Orphan Chrome processes

Symptom: Chrome processes survive after the MCP server exits.

v2 ships a 5-second shutdown watchdog and an aggressive teardown path, so this is rare. If it does happen:

1. Kill the lingering Chromes manually.
2. Run `cleanup_data` with `confirm: false` to preview relevant paths. It never
   removes locks or other files.
3. Verify no live Chrome owns the profile, remove a confirmed stale marker
   manually if necessary, then restart the server.

## Profile lock / `ProcessSingleton` errors

Cause: Another Chrome owns the base profile.

The server does not reject setup merely because a `Singleton*` path exists:
Chrome is launched first and only a matching launch error is classified as a
live profile conflict. This avoids false `profile_busy` results from stale
marker files.

Fix: The default `NOTEBOOK_PROFILE_STRATEGY=auto` falls back to an isolated per-instance profile only when a bootstrap-eligible recovery snapshot exists. `single` returns `profile_busy`; explicit `isolated` also requires that snapshot. To request isolation:

```bash
NOTEBOOK_PROFILE_STRATEGY=isolated ./scripts/mcp-launcher.sh
```

## Rate limit reached

Symptom: `NotebookLM rate limit reached (50 queries/day for free accounts)`.

Options:

- Use a distinct account data directory for a different Google account.
- Use multi-account mode for a clean separation:
  ```bash
  NOTEBOOKLM_ACCOUNT=backup ./scripts/mcp-launcher.sh
  ```
- Wait until the daily quota resets.
- Upgrade to Google AI Pro/Ultra for higher limits.

## Stealth typing too slow

The default `160–240 WPM` range is realistic but slow for batch use. Either disable stealth typing or tighten the range:

```bash
STEALTH_HUMAN_TYPING=false ./scripts/mcp-launcher.sh
# or
TYPING_WPM_MIN=400 TYPING_WPM_MAX=600 ./scripts/mcp-launcher.sh
```

## Citations are empty for `source_format=footnotes`

The DOM citation panel is read after the answer settles. If it is empty:

- The notebook may not have grounded sources for that question.
- The UI may have shifted — check the active selectors in `src/notebooklm/selectors.ts`.
- Run with `show_browser=true` and inspect the live page after the answer renders.

## Follow-up reminder is missing

In v2 the follow-up reminder appended to `ask_question` answers is off by default. Re-enable with:

```bash
NOTEBOOKLM_FOLLOW_UP_REMINDER=true ./scripts/mcp-launcher.sh
```

## AI marker breaks downstream parsing

The default answer text starts with `[AI-GENERATED via Gemini 2.5 (NotebookLM) — …]`. To return to the unprefixed answer, set:

```bash
NOTEBOOKLM_AI_MARKER=false ./scripts/mcp-launcher.sh
```

Or replace the prefix with your own:

```bash
NOTEBOOKLM_AI_MARKER_PREFIX="[notebooklm]" ./scripts/mcp-launcher.sh
```

The `_provenance` envelope on the result remains regardless.

## HTTP transport: `unknown session`

Cause: The client made a `GET /mcp` or `POST /mcp` (non-initialize) without echoing the `Mcp-Session-Id` returned by the initial `initialize` response.

Fix: Capture the `Mcp-Session-Id` response header from the initialize call and pass it on every subsequent request. The lifecycle is owned by the MCP SDK's `StreamableHTTPServerTransport`.
