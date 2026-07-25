# NotebookLM MCP 音声アップロード版：新規環境セットアップ

このフォルダは `notebooklm-mcp` v2.0.0 を基点にしたローカルfork（カスタム版 `0.0.2`）です。通常の `add_source`（Web URL／貼り付けテキスト）は変更せず、音声・YouTube登録、解析準備待ち、文字起こしエクスポートを追加しています。

基本フローは `add_source(type=url)`（通常Webサイト）または `add_youtube_source`／`add_audio_source` → `wait_for_source_ready` → `export_transcript` です。`export_transcript` はNotebookLMのソースビューア表示を直接抽出します（チャットのモデル申告ではありません）が、元メディアとの独立検証は行わず、上限により部分結果になる場合があります。Drive、PDF/DOCX/画像など一般ファイル、音声以外のStudio生成物は未対応です。

このカスタム版では **`npx notebooklm-mcp@latest` を使いません**。それは上流版を起動するため `add_audio_source` がありません。必ず、このフォルダの `scripts/mcp-launcher.sh` を `install.sh` 経由でCodex/Claudeへ登録します。`dist/index.js` の直接登録も不可です。音声許可ディレクトリとNode実行ファイルの固定が失われます。

`add_audio_source` は NotebookLM の画面内にあるファイル選択UIをPatchright経由で操作します。Whisper等の外部ASRへ音声を送ったり、音声をローカルで文字起こししたりしません。

基点は [`RELEASE_PROVENANCE.json`](./RELEASE_PROVENANCE.json) に固定しています（上流URL、`v2.0.0`、正確なコミット、カスタム版バージョン）。作者はこのカスタム版の `sasuketorii` とし、上流の original contributor と provenance は保持します。リポジトリ／ホームページ／バグ報告先はこのカスタム配布先を示します。

## 配布時の原則

このフォルダに含めてよいのはコード、`package-lock.json`、ドキュメント、`scripts/` だけです。以下は**絶対に同梱・Git管理・Dropbox同期しません**。

- `chrome_profile/`、`browser_state/`、`data/`（Googleログインを再利用できる機密情報）
- `.env`、APIキー、Cookie、セッション情報
- `node_modules/`、`dist/`、キャッシュ、音声ファイル

`get_health` はブラウザやネットワークを起動せず、実行中のNotebookLM readiness
または保守的なスナップショット証拠だけを返します。保存済みCookieが現在もGoogleに
受理されることを保証するものではありません。`setup_auth` と通常実行はプロファイルの
プロセス間リースを取得し、競合時は `profile_busy` を返します。`re_auth` は利用不可です。

配布前の内容確認とチェックサムは次で作れます。

```bash
git clone https://github.com/sasuketorii/notebooklm_mcp_with.git
cd notebooklm_mcp_with
./scripts/generate-manifest.sh
```

`./scripts/make-source-release.sh` が作る `*-source.tar.gz` は `.git` を含まない**インストール専用**アーカイブです。展開先で `install.sh` は実行できますが、上流追従はできません。上流を追従する運用には、このGitチェックアウトを保ちます。

## macOS / Linux：インストール

Node.js 22.13以上（推奨22 LTS）、Google Chrome、Codex CLIまたはClaude Codeを先に用意します。

```bash
cd notebooklm_mcp_with
chmod +x scripts/*.sh
mkdir -p "$HOME/notebooklm-audio-inbox"
./scripts/install.sh --all --audio-root "$HOME/notebooklm-audio-inbox"
./scripts/doctor.sh
```

`--all` はローカルビルドを以下の名前で登録します。

- Codex: `notebooklm-audio`
- Claude Code: `notebooklm-audio`

片方だけの場合は `./scripts/install.sh --codex` または `./scripts/install.sh --claude` を使います。登録先はこのフォルダの `scripts/mcp-launcher.sh` です。ランチャーは許可済み音声ルートとNode実行ファイルを固定して `dist/index.js` を起動します。移動・削除すると再登録が必要になります。

登録を行う場合、インストーラは先に指定された全CLI、音声ルート、Node/npmを検証してから設定を変更します。既存の `notebooklm-audio` を置換する途中で失敗した場合は、Codex/Claudeの元のユーザー設定を復元します。登録成功後にも `mcp get notebooklm-audio` を読み戻して確認します。CLI独自の保存先を変更している場合は、`CODEX_CONFIG_FILE` / `CLAUDE_CONFIG_FILE` に該当ファイルを指定してください。

## 初回Google認証

MCPを動かす**同じOSユーザー**でCodexまたはClaudeを起動し、次を依頼します。

```text
notebooklm-audio の setup_auth を show_browser=true で実行して
```

Googleログインと2段階認証を完了します。以後、CookieとChromeプロファイルはOSごとのアプリデータ領域に保存され、CodexとClaudeは同一OSユーザーであれば共用します。

`setup_auth` は既存の認証状態を保持したまま可視ブラウザを開きます。現在 `re_auth` は安全な段階Profile切替が未実装のため、既存の認証を変更せず fail-closed で終了します。アカウントを分ける場合は別OSユーザーまたは `NOTEBOOKLM_ACCOUNT` の別データ領域を使用してください。

| OS | プロファイル保存先 |
|---|---|
| macOS | `~/Library/Application Support/notebooklm-mcp/chrome_profile/` |
| Linux | `~/.local/share/notebooklm-mcp/chrome_profile/` |

認証状態は `./scripts/doctor.sh` で「プロファイルがある」ことだけ確認できます。Cookieの中身は表示・コピーしません。

## 音声をNotebookLMへ入れる

先に対象ノートブックを `select_notebook` で選ぶか、呼び出しごとに `notebook_id` または `notebook_url` を渡します。

```json
{
  "file_paths": [
    "<audio-root>/part-001.mp3",
    "<audio-root>/part-002.mp3"
  ],
  "notebook_id": "your-library-notebook-id",
  "show_browser": false
}
```

`<audio-root>` はインストール時に `--audio-root` で設定したディレクトリの実パスに置き換えてください（この例のプレースホルダーをそのまま送信しません）。

安全のため、音声はインストール時に指定した `--audio-root` 配下からしか読めません。1回につき最大10ファイル、1ファイル200 MiB、合計500 MiBです。拡張子に加え先頭バイトも確認します。結果にはSHA-256・バイト数・NotebookLMのソース件数前後・画面で確認できたファイル名が返ります。

`success: true` はアップロード行がNotebookLMのソース欄で確認できたことを意味します。NotebookLM側の解析／文字起こし完了は非同期なので、その後に質問・文字起こし処理を行います。

## VPS（Linux）

実行用ユーザーを作り、その同一ユーザーでインストール、認証、常駐を行います。rootとサービスユーザーで認証プロファイルを共有しないでください。`--audio-root` に指定する音声パスは**VPSローカルのパス**です。Telegram等から受け取る場合も、先にそのサービスユーザーだけが書込できるVPS内の入力ディレクトリへ保存し、そのディレクトリだけを許可します。

1つのChromeプロファイルは1つの信頼境界です。異なる依頼者・Googleアカウント・テナントで認証プロファイルを共用せず、アカウントごとに別OSユーザーまたは別データディレクトリを用意してください。同じプロファイルに対して、`setup_auth` と通常のブラウザ操作を同時実行しないでください。`re_auth` は利用不可です。

初回ログインだけは表示付きのブラウザが必要です。VPSにGUIがなければ、短時間だけXvfb＋noVNCまたはSSH X11転送を使い、`setup_auth` を `show_browser=true` で実行します。ログイン後は通常 `HEADLESS=true` で構いません。

ローカル限定HTTP起動は次です。

```bash
cd notebooklm_mcp_with
HEADLESS=true ./scripts/start-http.sh
```

既定値は `127.0.0.1:3000` です。外部公開する場合も、MCPを直接インターネットに晒さず、Tailscaleまたは認証付きのリバースプロキシを別途用意してください。

現時点ではブラウザ表示設定など一部の実行設定がプロセス全体で共有されます。そのため、1プロセスを高並列ワーカーとして使うより、音声アップロードと認証を直列キューにし、必要なら信頼境界ごとに別プロセスを起動する運用が安全です。また、アップロード前に実パス・拡張子・先頭バイトを検証していますが、検証後に同じパスのファイルが外部から差し替えられるTOCTOUリスクを完全には除去できません。許可音声ルートは受信専用・単一サービスユーザー書込にしてください。

## 更新

上流との差分を安全に確認します。

```bash
./scripts/update-upstream.sh
```

表示された差分をレビューし、作業ツリーが空であることを確認してからのみマージします。

```bash
./scripts/update-upstream.sh --apply
```

`--apply` はマージ後に `npm ci`、`npm run check`、完全な `npm test`、配布manifestの再生成・検証を順に実行し、いずれかが失敗すれば非0で停止します。その後、必ず `./scripts/doctor.sh` を実行し、`add_audio_source` を可視ブラウザで1ファイル検証してください。NotebookLMのUI変更でアップロードが失敗した場合は、`show_browser=true` で画面を確認し、`src/notebooklm/selectors.ts` の音声アップロード選択子を更新します。マージ後にこれらの検証が失敗しても、リポジトリはマージ済みの状態のままです。自動の `reset`／巻き戻しは行いません。失敗内容をレビューし、修正コミットまたは明示的にレビューしたロールバックを選んでください。

上流更新はGitチェックアウトでのみ実行できます。source-onlyアーカイブには `.git` がないため、そこで `update-upstream.sh` は実行できません。上流リモート名は `upstream` があればそれを、なければ `origin` を使います。別名の場合は `NOTEBOOKLM_UPSTREAM_REMOTE`、対象ブランチは `NOTEBOOKLM_UPSTREAM_BRANCH` で指定できます。配布用のsource-onlyアーカイブは `./scripts/make-source-release.sh` で生成できます。

## よくある問題

- **`No target notebook selected`**: `notebook_id` / `notebook_url` を渡すか、`select_notebook` を先に実行します。
- **ファイル選択UIが見つからない**: NotebookLM UIが更新された可能性があります。`show_browser=true` で再現し、セレクタを更新します。
- **プロファイルはあるがログイン画面になる**: Google側でセッションが無効化されています。`setup_auth` を可視ブラウザで実行します。
- **VPSでブラウザが起動しない**: Chrome依存パッケージと一時ディスプレイを確認し、初回認証をXvfb/noVNCで行います。
- **アップロード成功後すぐ質問して内容がない**: NotebookLMの解析待ちです。ソース欄の状態を確認してから再試行します。
