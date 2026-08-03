# Agent-guided setup

This is the authoritative installation guide for agents operating Codex or
Claude Code. `AGENTS.md` and `CLAUDE.md` intentionally point here so the
installation contract is maintained once.

## User handoff

The intended user instruction is simply:

> Set up https://github.com/sasuketorii/notebooklm_mcp_with using its agent setup guide.

An agent must clone this repository and run the supported bootstrap entrypoint:

```bash
./scripts/bootstrap.sh --auto
```

`--auto` discovers the supported installed clients. Use `--codex`, `--claude`,
or `--all` only when the user has made that target explicit. The bootstrap
preflights Git, Node.js, npm, the reviewed release provenance/lineage, and the
requested clients before it mutates their configuration. It then performs a
clean dependency install, build, checks, tests, transactional registration and
read-back validation, and `doctor`. It rolls back a failed registration.

Bootstrap always verifies the checked-out release's local reviewed
provenance/lineage. Add `--require-upstream-current` only when the user also
requires a live online check that the checkout includes the current upstream
main commit; that optional gate fails closed before installation. It does not
merge or execute unreviewed upstream code. Do not replace bootstrap with
`npx notebooklm-mcp@latest`, manual `mcp add`, or direct execution of
`dist/index.js`.

The one-prompt setup path requires a real Git checkout: its local lineage
verification needs repository history. A `*-source.tar.gz` made by the release
script excludes `.git`, so it is an inspection/audit artifact and is not a
supported bootstrap installation input.

Unless the user supplies an explicit private directory with `--audio-root`,
bootstrap creates `$HOME/notebooklm-audio-inbox` mode `0700`. The directory is
a local allowlist for files passed to `add_audio_source`; it must be private to
the user or service account that runs the MCP and must not be a broad home,
Downloads, Dropbox, or shared directory. If the default does not meet that
requirement, the agent must ask the user for a safe directory.

## Launcher environment compatibility

The private `.audio-roots.env` launcher file supports the legacy two-key stdio
form: `NOTEBOOKLM_NODE_BIN` plus `NOTEBOOKLM_AUDIO_ROOTS`. A bearer-token key
(`NOTEBOOKLM_HTTP_BEARER_TOKEN`) is optional for stdio, because stdio does not
open a network listener. It is required for `scripts/start-http.sh` and the
HTTP transport. The installer may safely migrate or write the current
three-key form; agents must not hand-edit the file or expose its token.

## Single-server rule

Maintain one managed server: this fork, registered as `notebooklm-audio` (with
the reserved upstream name `notebooklm` recognized for conflict handling). It
already contains the reviewed upstream functionality plus this fork's custom
audio/YouTube workflow. Do not install the upstream server alongside it, and
do not merge or download upstream code during user installation.

`reviewed latest at release` means the maintainer has selected, integrated,
and tested an upstream revision before publishing a fork release. It does not
mean this bootstrap dynamically combines whatever upstream version exists at
install time. The fork's `RELEASE_PROVENANCE.json` is the authoritative record
of the reviewed upstream base for the checked-out release.

Before registration, bootstrap checks only the reserved names
`notebooklm-audio` and `notebooklm`. Arbitrary aliases cannot be inventoried;
manually remove conflicting aliases before setup. For a reserved-name conflict,
preserve details and explain the conflict; never delete authentication data,
browser profiles, or unrelated MCP entries.

The installer serializes cooperative installs with an atomic per-client lock
next to that client's configuration. It acquires every requested lock before
inventory and holds it through mutation, read-back, and rollback. Lock
contention fails closed; PID metadata is informational only, and the installer
never guesses that an existing lock is stale or removes it automatically.
After confirming that no installer process is running, a same-user operator may
inspect and manually remove an abandoned lock. Direct `codex mcp`, `claude mcp`,
or config-file edits by another same-user process do not participate in this
protocol and cannot be made atomic by the installer; pause those writers for the
entire bootstrap transaction.

## Authentication and completion

After bootstrap succeeds, restart every client that was registered. Then, in
one restarted client running as the same operating-system user, invoke
`notebooklm-audio` `setup_auth` with `show_browser=true`. Google sign-in and
two-factor authentication are intentionally human steps; an agent must wait
for the user to complete them and must never request, copy, print, or commit
passwords, cookies, browser profiles, or one-time codes.

`setup_auth` does not intentionally wipe existing authentication data.
However, an interactive Google login can update the persistent browser profile
or session, so it provides no preservation guarantee. Do not present it as a
non-mutating repair operation.

The current compatibility endpoints have deliberate limits: `re_auth` is
unavailable (fail-closed), and `cleanup_data` is preview-only. Do not offer
either as an automated repair path.

Report completion only after the bootstrap read-back checks succeed, the
clients have been restarted, and the authentication step has either succeeded
or is explicitly awaiting the user's Google/2FA interaction.

## Maintaining this fork

Upstream tracking is a maintainer release workflow, never an end-user setup
step. A maintainer reviews the upstream diff, preserves this fork's custom
behavior, runs the full verification suite, obtains review approval, and
publishes a new fork release. Users update by installing a reviewed release of
this fork only.

The v0.0.7 release retains the fork-owned audit tag
`refs/tags/upstream/notebooklm/v2.0.0`, already public on `origin` at the
reviewed immutable SHA. That existing audit tag is unchanged and is not pushed
again; the release push for v0.0.7 contains only `main` and the custom `v0.0.7`
tag. Future reviewed integrations use `upstream/notebooklm/vX.Y.Z`.
`scripts/update-upstream.sh` prepares and checks a candidate only; it never
creates or pushes tags, merges, or publishes releases.

For user-facing operational detail, see the root README and
[`SETUP_JA.md`](../SETUP_JA.md). For source, capability, and safety limits, see
[`tools.md`](./tools.md) and [`configuration.md`](./configuration.md).
