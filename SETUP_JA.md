# NotebookLM MCP 音声アップロード版：新規環境セットアップ

このフォルダは `notebooklm-mcp` を基点にしたローカルforkです。通常の `add_source`（Web URL／貼り付けテキスト）は変更せず、音声・YouTube登録、解析準備待ち、文字起こしエクスポートを追加しています。リリースごとのレビュー済み上流基点は `RELEASE_PROVENANCE.json` を正とします。

基本フローは `add_source(type=url)`（通常Webサイト）または `add_youtube_source`／`add_audio_source` → `wait_for_source_ready` → `export_transcript` です。`export_transcript` はNotebookLMのソースビューア表示を直接抽出します（チャットのモデル申告ではありません）が、元メディアとの独立検証は行わず、上限により部分結果になる場合があります。Drive、PDF/DOCX/画像など一般ファイル、音声以外のStudio生成物は未対応です。

このカスタム版では **`npx notebooklm-mcp@latest` を使いません**。それは上流版を起動するため `add_audio_source` がありません。インストールは必ず [`docs/agent-setup.md`](./docs/agent-setup.md) のbootstrap経由で行います。`dist/index.js` の直接登録も不可です。音声許可ディレクトリとNode実行ファイルの固定が失われます。

`add_audio_source` は NotebookLM の画面内にあるファイル選択UIをPatchright経由で操作します。Whisper等の外部ASRへ音声を送ったり、音声をローカルで文字起こししたりしません。

基点は [`RELEASE_PROVENANCE.json`](./RELEASE_PROVENANCE.json) に固定しています（上流URL、正確なコミット、カスタム版バージョン）。作者はこのカスタム版の `sasuketorii` とし、上流の original contributor と provenance は保持します。リポジトリ／ホームページ／バグ報告先はこのカスタム配布先を示します。

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

`./scripts/make-source-release.sh` が作る `*-source.tar.gz` は `.git` を含まないため、内容確認・監査用のアーティファクトです。one-prompt bootstrapはlineage検証にGit履歴を必要とするため、このアーカイブをセットアップ入力には使用しません。セットアップには必ずGitチェックアウトを使用します。

## macOS / Linux：インストール

Node.js 22.13以上、npm、Git、Codex CLIまたはClaude Codeを先に用意します。ユーザーはこのリポジトリURLをCodexまたはClaude Codeへ渡し「セットアップして」と依頼できます。エージェントは必ず [`docs/agent-setup.md`](./docs/agent-setup.md) に従い、`./scripts/bootstrap.sh --auto` を実行します。

bootstrapは、対応CLIの検出、Git/Node/npmとチェックアウト済みリリースのレビュー済みprovenance/lineageの事前検証、安全な依存関係導入、build/check/test、`doctor`、MCP登録と読み戻し検証、失敗時ロールバックをまとめて行います。対象を明示する場合だけ `--codex`、`--claude`、`--all` を使います。上流mainの現在のcommitまで統合済みかをオンラインで追加確認する必要がある場合だけ `--require-upstream-current` を加えます。この追加gateはインストール前にfail-closedで停止しますが、上流コードのマージ・実行は行いません。

音声入力先を指定しなければ、bootstrapは `$HOME/notebooklm-audio-inbox` を権限 `0700` で作成します。`--audio-root` で指定する場合も、実行OSユーザー／サービスユーザーだけが読める非共有ディレクトリにしてください。ホーム全体、Downloads、Dropbox、共有ディレクトリは指定しません。

管理対象のMCP名はカスタム版 `notebooklm-audio` と予約名 `notebooklm` です。
任意の別名エイリアスは自動棚卸しできないため、競合する場合はセットアップ前に
手動で削除してください。予約名の競合や識別不能な登録があればbootstrapは安全に
停止し、認証データ、Chromeプロファイル、無関係なMCP登録は削除しません。
インストール成功後は、登録されたCodex／Claude Codeをすべて再起動してください。

## 初回Google認証

MCPを動かす**同じOSユーザー**でCodexまたはClaudeを起動し、次を依頼します。

```text
notebooklm-audio の setup_auth を show_browser=true で実行して
```

Googleログインと2段階認証を完了します。以後、CookieとChromeプロファイルはOSごとのアプリデータ領域に保存され、CodexとClaudeは同一OSユーザーであれば共用します。

`setup_auth` は既存の認証情報を意図的に削除しませんが、対話ログインにより永続プロファイルやセッションが更新されるため、状態保持は保証しません。現在 `re_auth` は安全な段階Profile切替が未実装のため、既存の認証を変更せず fail-closed で終了します。アカウントを分ける場合は別OSユーザーまたは `NOTEBOOKLM_ACCOUNT` の別データ領域を使用してください。

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

ランチャーの非公開 `.audio-roots.env` は、stdio向けの旧2キー形式 `NOTEBOOKLM_NODE_BIN` と `NOTEBOOKLM_AUDIO_ROOTS` を受け付けます。stdioはネットワーク待受を開かないためBearer tokenは任意ですが、HTTP起動には `NOTEBOOKLM_HTTP_BEARER_TOKEN` が必須です。インストーラはtokenを含む現行3キー形式を安全に移行・書込みできます。ファイルを手編集したりtokenを表示・共有したりしないでください。

現時点ではブラウザ表示設定など一部の実行設定がプロセス全体で共有されます。そのため、1プロセスを高並列ワーカーとして使うより、音声アップロードと認証を直列キューにし、必要なら信頼境界ごとに別プロセスを起動する運用が安全です。また、アップロード前に実パス・拡張子・先頭バイトを検証していますが、検証後に同じパスのファイルが外部から差し替えられるTOCTOUリスクを完全には除去できません。許可音声ルートは受信専用・単一サービスユーザー書込にしてください。

## 更新

利用者は更新時もこのforkのレビュー済みリリースだけを導入します。インストール時に上流の最新版を取得・結合することはありません。「レビュー済み最新」は、当該forkリリースの公開前にメンテナーが選定・統合・テストした上流状態を意味します。正確な基点は `RELEASE_PROVENANCE.json` を確認してください。

上流追従はメンテナーのリリース作業です。Gitチェックアウトから `scripts/update-upstream.sh` を使って差分をレビューし、カスタム音声機能を保った上で、全検証・実機smoke・レビュー承認を経て新しいforkリリースを公開します。source-onlyアーカイブには `.git` がないため、上流追従には使用しません。

このリリースでは、レビュー済み上流コミットを示すfork側の監査タグ
`upstream/notebooklm/v2.0.0`（完全なrefは
`refs/tags/upstream/notebooklm/v2.0.0`）は、レビュー済みの不変SHAで
originに公開済みです。今回のrelease push対象は `main` とカスタム
`v0.0.5` タグだけです。今後のレビュー済み統合も
`upstream/notebooklm/vX.Y.Z` 形式を使います。updaterはレビュー候補の準備だけを行い、タグ作成・push・merge・
リリース公開を自動実行しません。

## よくある問題

- **`No target notebook selected`**: `notebook_id` / `notebook_url` を渡すか、`select_notebook` を先に実行します。
- **ファイル選択UIが見つからない**: NotebookLM UIが更新された可能性があります。`show_browser=true` で再現し、セレクタを更新します。
- **プロファイルはあるがログイン画面になる**: Google側でセッションが無効化されています。`setup_auth` を可視ブラウザで実行します。
- **VPSでブラウザが起動しない**: Chrome依存パッケージと一時ディスプレイを確認し、初回認証をXvfb/noVNCで行います。
- **アップロード成功後すぐ質問して内容がない**: NotebookLMの解析待ちです。ソース欄の状態を確認してから再試行します。
