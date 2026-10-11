# dsh-siwc-bridge（SIWC Bridge for DSH）

DeepSeek Harness（DSH）で、**自分のChatGPTプラン**のモデルを使えるようにするプラグインです。OpenAIの公開仕様「Sign in with ChatGPT（SIWC）」で本人がサインインし、公開Responses APIを呼びます。会話・ツール・権限・作業フォルダ・添付などは、すべてDSH本来の機能をそのまま使います。

個人開発の非公式プラグインです。OpenAI・DeepSeekの公式製品ではありません。このフォルダは [siwc-bridge](../../README.md) に含まれるDSH接続です。

## 最短手順

Windows 11、Node.js 24、Gitが必要です。PowerShellで実行します。

```powershell
git clone https://github.com/Eureka-COM/siwc-bridge.git
cd siwc-bridge\integrations\dsh
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run setup              # build と、専用のDSH環境への導入
node lib/cli.js login          # ブラウザで本人がサインインし、ChatGPTプランの利用を許可
npm.cmd start                  # DSHの画面を開く
```

DSHの画面では、入力欄のモデル選択で「ChatGPT plan (SIWC)」のモデルを選びます。入力欄の横に「Using ChatGPT plan · Manage usage」と表示されます。

## ⚠ 使う前の注意（課金）

ChatGPTの設定によっては、**プランの利用枠を使い切った後に、有料のクレジットが自動で使われる**ことがあります。[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) の **App limits → SIWC Bridge for DSH** で、週間上限を100%未満にするか、クレジット利用をOFFにしてください。自動購入をOFFにするだけでは、すでにあるクレジットの消費は防げません（[公式の説明](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)）。アプリ名は最初のサインインの後に一覧へ表示されます。

## できること

- **会話・ツール**：DSHのツール（ファイルの読み書き、コマンド、サブエージェント、MCPなど）をそのまま使えます。複数のツールを並行して呼ぶ応答にも対応します。実行の承認や作業範囲はDSHの設定に従います。
- **画像の添付**：添付した画像をモデルへ画像として送ります（最大2048×2048ピクセル・1枚約1 MiB、1回の要求で合計約20 MiBまで。超える分はDSHの標準機能で古い画像から文字の参照に置き換えます）。ツール結果に含まれる画像も送ります。
- **ファイルの添付**：DSHの設計どおり、保存場所をモデルへ伝え、モデルがDSHのreadツールで読みます。
- **推論の度合い**：公式仕様で確認できたモデルでは、モデルメニューで low〜max（モデルによって none も）を選べます。
- **長い会話**：公式仕様のモデルでは文脈の長さをDSHへ伝え、DSHの圧縮（compaction）が働きます。
- **中断・再開・モデル切り替え**：途中で止めても次の依頼は普通に送れます。会話の途中でモデルを変えても続けられます。

## 動作の考え方

- 応答は、公式仕様どおり `response.completed` を受け取ったときだけ成功とします。
- 本文・ツール呼び出し・推論の要約・完了・エラー以外の通知は読み飛ばし、作業を止めません。読み飛ばしたものの**種類の名前だけ**を診断ログに残します。
- 一時的な障害（通信の切断、サーバー側の 5xx、利用枠の確認不能など）は、DSHの再試行機能で間隔を空けて再試行します。
- 利用上限のエラーを受けたときは、新しい要求を止めて「Manage usage」へ案内します（公式ガイドラインどおり）。確認した後、`/siwc resume` で再開します。
- サインインの登録を切り替えた後は、前の登録で作られた内部の推論情報を使わずに会話を続けます（会話の本文とツールの結果は引き継ぎます）。
- 速度の Fast（優先処理）は、SIWCに公式な指定方法がないため使えません。

## コマンド

DSH画面では `/siwc`、ターミナルでは `node lib/cli.js` で使います。

| 操作 | DSH画面 | ターミナル |
|---|---|---|
| 状態（サインイン・既定モデル・上限） | `/siwc status` | `status` |
| サインイン・再サインイン | `/siwc login [登録ID]` | `login [登録ID]` |
| モデル一覧（最新） | `/siwc models` | `models` |
| 次回起動時の既定モデル | `/siwc model <slug>` | `model <slug>` |
| 登録の切り替え | `/siwc select <登録ID>` | `select <登録ID>` |
| サインアウト | `/siwc sign-out` | `sign-out` |
| 利用状況のページ | `/siwc manage` | — |
| 上限停止からの再開 | `/siwc resume` | — |
| 診断ログ（最近の記録） | `/siwc diagnostics` | `diagnostics` |

プランの利用許可を後から与える場合は、ターミナルで `node lib/cli.js enable-plan <登録ID>` を実行します。

## 保存するもの

すべて `%LOCALAPPDATA%\siwc-bridge-dsh` にあり、このWindowsユーザーだけが読めます。

- `credentials.dpapi`：サインイン情報（Windows DPAPIで暗号化）
- `model-catalog.json`：モデル一覧（名前だけ）。次回すぐ表示するために使い、裏で最新化します。
- `selected-model.json`：次回起動時の既定モデル
- `diagnostics.log`：要求ごとの時刻・モデル・結果・HTTP状態・request ID・所要時間と、読み飛ばした通知の種類名。会話の本文、ツールの内容、トークン、サービスのエラー本文は書きません（512 KiBで切り替え）。

## テスト

```powershell
npm.cmd run typecheck
npm.cmd test                   # 架空の資格情報と模擬応答だけを使います
npm.cmd run e2e                # 実際のChatGPTプランでDSHの通しテスト（画面なし）
npm.cmd run e2e:web            # DSH Webと同じ経路で画像・ファイル添付・中断を通しテスト（画面なし）
```

`e2e` と `e2e:web` は実際にモデルへ要求を送るので、プランの利用枠を使います。

## 削除・再導入

```powershell
node lib/cli.js sign-out
npm.cmd run remove:plugin
npm.cmd run setup
```

サインアウトは、この端末のトークンを削除し、サーバー側での失効も試みます。接続そのものの解除は ChatGPT の Security and login → Login connections → Sign in with ChatGPT → Disconnect です。完全に消す場合は、サインアウト後に `%LOCALAPPDATA%\siwc-bridge-dsh` とこのフォルダを削除してください。

## 確認した版と資料

Windows 11、Node.js 24.13.0、DSH `0.2.1-alpha.1`。依存は package-lock.json に固定しています。DSHは開発途中のプレビュー版です。[公式の安全上の注意](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/SAFETY.md)も読んでください。

公式仕様との照合は [docs/COMPLIANCE.md](docs/COMPLIANCE.md)、実際に確認した内容は [docs/VERIFICATION.md](docs/VERIFICATION.md) にあります。
