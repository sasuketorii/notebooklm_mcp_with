# NotebookLM MCP with Audio (custom fork)

Repository: <https://github.com/sasuketorii/notebooklm_mcp_with><br>
Version: **0.0.2 (source-only distribution)**

This is a maintained custom fork of [PleasePrompto/notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp). It keeps NotebookLM chat, web-URL/text sources, library and audio-overview tools, and adds a bounded local-audio/YouTube workflow. It is intended for local or single-principal use through Codex or Claude Code; it is not an npm package release.

このリポジトリは [上流 notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp) のカスタムforkです。チャット、Web URL／テキストソース、ライブラリ、Audio Overviewを維持し、ローカル音声・YouTube登録、準備待ち、UI文字起こし出力を追加します。Codex／Claude Codeからのローカルまたは単一信頼主体での利用を想定し、npmパッケージとしては公開していません。

## What this fork adds / このforkの目的

- `add_audio_source`: NotebookLMのファイル選択UIで音声を登録（外部ASRへ送信しない）。
- `add_youtube_source`: 公開YouTube URLをNotebookLMへ登録。
- `wait_for_source_ready`: ソース一覧のUI状態を安定ポーリング。
- `export_transcript`: ソースビューアに表示された文字列をmarkdown/jsonで保存。
- `audio-root` allowlist、SHA-256／サイズ receipt、入力形式・サイズ上限。

The remaining tools cover Q&A (`ask_question`), URL/text ingestion (`add_source`), Audio Overview generation/status/download, notebook library CRUD/search, session lifecycle, health, authentication, and cleanup.<br>
その他に、質問応答、URL／テキスト登録、Audio Overviewの生成・状態確認・ダウンロード、ノートブックの追加・検索・更新・削除、セッション管理、health、認証、cleanupを提供します。

The source viewer output is not an independently verified, verbatim transcript of the original media. It can be partial or indeterminate; always inspect `completeness`, `warnings`, and `verifiedComplete:false` before publishing it.

ソースビューアの出力は元音声・動画との独立検証済み逐語録ではありません。部分結果や判定不能になり得るため、公開前に `completeness`、`warnings`、`verifiedComplete:false` を必ず確認してください。

## Features and tools / 機能・ツール

**Questions and sources:** `ask_question`, `add_source` (URL or pasted text), `add_audio_source`, `add_youtube_source`, `wait_for_source_ready`, `export_transcript`<br>
**Audio Overview:** `generate_audio`, `get_audio_status`, `download_audio`<br>
**Notebook library:** `add_notebook`, `list_notebooks`, `get_notebook`, `select_notebook`, `update_notebook`, `remove_notebook`, `search_notebooks`, `get_library_stats`<br>
**Sessions/system:** `list_sessions`, `close_session`, `reset_session`, `get_health`, `setup_auth`; compatibility endpoints `re_auth` (unavailable/fail-closed) and `cleanup_data` (preview-only)<br>

Full schemas and return envelopes are in [`docs/tools.md`](./docs/tools.md).

各ツールの引数、戻り値、上限は [`docs/tools.md`](./docs/tools.md) にあります。`add_audio_source` は外部文字起こしサービスを呼ばず、`add_youtube_source` は公開URLだけを受け付けます。

## Install and register / インストールと登録

Requirements: Node.js **22.13+**, Google Chrome (or bundled Patchright Chromium), and Codex CLI and/or Claude Code.

```bash
git clone https://github.com/sasuketorii/notebooklm_mcp_with.git
cd notebooklm_mcp_with
chmod +x scripts/*.sh
mkdir -p "$HOME/notebooklm-audio-inbox"
./scripts/install.sh --all --audio-root "$HOME/notebooklm-audio-inbox"
./scripts/doctor.sh
```

`install.sh --codex` and `--claude` register the local `scripts/mcp-launcher.sh` as `notebooklm-audio`. The launcher fixes the built entrypoint, Node executable, and permitted audio root. Do **not** register `dist/index.js` directly.

`npx notebooklm-mcp@latest` is **upstream only** and does not contain these custom tools. Do not use it as this fork's installation command.

The launcher can also be registered manually:

```bash
# Codex CLI
codex mcp add notebooklm-audio -- "$PWD/scripts/mcp-launcher.sh"
# Claude Code
claude mcp add notebooklm-audio -- "$PWD/scripts/mcp-launcher.sh"
```

`install.sh` performs the supported validation and rollback checks; prefer it when both clients are installed.

`install.sh` はNode/npm、CLI、音声ルートを検証してから登録し、途中で失敗した場合は既存設定を復元します。手動登録では現在のチェックアウトの `scripts/mcp-launcher.sh` を指定し、上流の `npx` や `dist/index.js` を指定しないでください。

After registration, restart the client and verify that the server name is `notebooklm-audio`; both clients use the same per-OS-user browser profile.<br>
登録後はクライアントを再起動し、サーバー名が `notebooklm-audio` であることを確認してください。両クライアントは同じOSユーザーのブラウザプロファイルを共有します。

## Authentication / 認証

In the same OS user that will run the MCP server, ask either client:

```text
Run notebooklm-audio setup_auth with show_browser=true.
```

ログイン画面を表示してGoogleログインを完了してください。認証プロファイルはOSユーザーのアプリデータ領域に保存されます。`re_auth` は現在利用不可で、アカウント切替や認証削除は行いません。VPS/headless Linuxでは初回のみ `xvfb-run`、noVNC、またはSSH X11で表示を提供し、その後は `HEADLESS=true` で常駐できます。rootとサービスユーザーでプロファイルを共有しないでください。

## Workflows / ワークフロー

1. Select a notebook with `select_notebook`, or pass `notebook_id`/`notebook_url` on each call.
2. Website: `add_source(type="url")`; YouTube: `add_youtube_source(url)`; local audio: `add_audio_source(file_paths=[...])`.
3. Wait with `wait_for_source_ready(source_names=[...])`.
4. Ask with `ask_question`, or extract UI text with `export_transcript`.
5. For Audio Overview use `generate_audio` → `get_audio_status` → `download_audio`.

Audio limits: 1–10 files per call, supported extensions (`mp3`, `m4a`, `aac`, `wav`, `flac`, `ogg`, `opus`), **200 MiB per file / 500 MiB total**. Files must be regular files beneath the configured `--audio-root`. NotebookLM indexing remains asynchronous.

音声は1回1〜10ファイル、対応拡張子は上記のみ、1ファイル200 MiB・合計500 MiBまでです。`--audio-root` 配下の通常ファイルだけが対象で、登録成功後もNotebookLMの解析は非同期です。必ず `wait_for_source_ready` を実行してから質問・出力してください。

## HTTP loopback and security / HTTPループバックと安全性

```bash
export NOTEBOOKLM_HTTP_BEARER_TOKEN="$(openssl rand -hex 32)"
HEADLESS=true ./scripts/start-http.sh
```

The server binds to `127.0.0.1` (and uses `/mcp` plus `/healthz`). Bearer authentication is required; this is a single-principal trust domain. Never commit the token, expose cleartext HTTP publicly, or share one token across tenants. For remote access, put TLS and authentication in a separately managed reverse proxy or private Tailscale network. The stdio transport is the default and avoids opening a network listener.

HTTPは `127.0.0.1` のみにbindし、Bearer token（32 byte以上）を要求します。tokenをコミットせず、平文HTTPを公開せず、複数テナントで共有しないでください。遠隔利用はTLS・認証付きリバースプロキシまたは非公開Tailscaleを前段に置きます。既定のstdioはネットワーク待受を開きません。

Generate a fresh token per deployment with a secret manager or `openssl rand -hex 32`; do not paste a reusable token into shell history, documentation, or source control.<br>
デプロイごとにsecret managerまたは `openssl rand -hex 32` で新しいtokenを生成し、再利用可能なtokenを履歴・文書・ソースへ貼り付けないでください。

## Limits and unsupported features / 制限と未対応

This fork automates the NotebookLM web UI and may require selector updates when Google changes it. `export_transcript` is UI extraction, not source/media verification or external speech recognition. Google Drive, generic PDF/DOCX/image uploads, arbitrary local files, multi-tenant shared auth, and non-audio Studio artifacts are unsupported. Do not treat an `add_*` success receipt as completed indexing.

GoogleがUIを変更するとセレクタ更新が必要です。`export_transcript` はUI抽出であり、元メディア検証や外部ASRではありません。Drive、一般PDF/DOCX/画像、任意ローカルファイル、共有マルチテナント認証、音声以外のStudio成果物は未対応です。`add_*` のreceiptだけで解析完了と判断しないでください。

There is no promise of API stability across NotebookLM UI changes; pin a reviewed commit for production-like use and re-run the smoke tests after updates.<br>
NotebookLMのUI変更に対するAPI互換性は保証しません。継続運用ではレビュー済みcommitを固定し、更新後にsmoke testを再実行してください。

## VPS/headless operations / VPS運用

Use one service OS user and one Chrome profile per Google account/trust boundary. Keep the audio inbox private and writable only by that service. Run HTTP on loopback and front it with a private, authenticated proxy if needed. Authentication uses a cross-process base-profile lease: contending runtime/setup operations return `profile_busy`; runtime may use a disposable isolated profile only with a bootstrap-eligible snapshot, while `single` never falls back. `re_auth` is unavailable and fails closed until safe staged-profile switching exists. `get_health` is offline: `runtime_verified` is live evidence from this process, `snapshot_usable` is unexpired persistent-cookie evidence, and neither guarantees Google will accept saved cookies on the next request.

VPSでは実行専用OSユーザーとGoogleアカウントごとのChromeプロファイルを用意し、音声入力ディレクトリをそのユーザーだけが書けるようにします。認証・音声登録は同一プロファイルで直列化し、`setup_auth` と通常操作を同時実行しません。`re_auth` は現在利用できません。

## Upstream updates / 上流追従

Keep a Git checkout (source-only archives have no `.git`). Review the diff before applying:

```bash
./scripts/update-upstream.sh
./scripts/update-upstream.sh --apply
```

The apply path runs install/check/test and manifest verification, but a failed check does not automatically reset a merge. Re-review custom audio selectors and run a visible `add_audio_source` smoke test after NotebookLM UI changes.

`--apply` はinstall/check/testとmanifest検証を実行しますが、失敗時に自動resetしません。UI変更後は音声セレクタをレビューし、`show_browser=true` の実機音声登録を確認してください。

## Tests and source-only release / テストと配布

```bash
npm ci
npm run check
npm test
./scripts/make-source-release.sh
```

`npm run check` はformat/lint/build、`npm test` は音声、YouTube、readiness、transcript、HTTP concurrency、権限、workflow、source-release等の回帰検証を実行します。

Run these checks before publishing a source archive; no generated `dist` or credentials belong in the archive.<br>
source archiveを公開する前に検証を実行し、生成物 `dist` や認証情報をアーカイブへ含めないでください。

The release contains source, lockfile, scripts, and documentation only—never cookies, Chrome profiles, `.env`, `node_modules`, `dist`, or audio. `RELEASE_PROVENANCE.json` is the authoritative record of the upstream base, exact provenance, and custom version; the public repository URL for this fork is the one shown at the top of this README.

配布物はソース、lockfile、scripts、ドキュメントだけで、Cookie・Chromeプロファイル・`.env`・`node_modules`・`dist`・音声は含めません。上流基点、正確なprovenance、カスタム版バージョンは `RELEASE_PROVENANCE.json` を正とし、公開先はREADME冒頭のこのforkのURLです。

## Related repositories / 関連リポジトリ

- **This fork:** <https://github.com/sasuketorii/notebooklm_mcp_with> — audio/YouTube custom implementation and release process.
- **Upstream server:** <https://github.com/PleasePrompto/notebooklm-mcp> — original NotebookLM MCP server and baseline implementation.
- **Upstream skill:** <https://github.com/PleasePrompto/notebooklm-skill> — separate agent skill/integration; it is not this server and its `npx` examples must not be mistaken for this fork's installer.

## License / ライセンス

MIT; see [`LICENSE`](./LICENSE). Custom changes are distributed as source under the same license, with provenance in [`RELEASE_PROVENANCE.json`](./RELEASE_PROVENANCE.json).

Japanese operational detail: [`SETUP_JA.md`](./SETUP_JA.md).<br>
English reference: [`docs/configuration.md`](./docs/configuration.md), [`docs/usage-guide.md`](./docs/usage-guide.md), [`docs/troubleshooting.md`](./docs/troubleshooting.md).
