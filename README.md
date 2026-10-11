# siwc-bridge

Windows上のNode.jsアプリやハーネスへ、本人のChatGPTプランとの接続を組み込む汎用SDKです。公式の **Sign in with ChatGPT（SIWC）** でログインし、公開OAuth/OIDC・Responses APIを利用します。

SDK本体は特定のハーネスに依存せず、認証・安全なローカル保存・要求予算・モデル通信を提供します。ツールの承認・実行・結果返却・会話履歴は、組み込み先の既存ループが管理します。接続例としてDeepSeek Harness（DSH）用アダプターも別フォルダに収録しています。OpenAI・DeepSeekの公式製品や公認SDKではありません。

公開リポジトリ: [Eureka-COM/siwc-bridge](https://github.com/Eureka-COM/siwc-bridge)。npmレジストリには公開していません。

## 最短手順

- **DSHで使いたい**：[DSH接続の最短手順](integrations/dsh/README.md#最短手順)へ。clone、`npm.cmd run setup`、ブラウザでのサインイン、`npm.cmd start` の4段階です。
- **自分のNode.jsアプリに組み込みたい**：下の「Windowsでの準備」と「開発者向け：既存ループへの組み込み」へ。
- **実モデルを呼ばずに動きだけ見たい**：clone後に `npm.cmd ci --ignore-scripts`、`npm.cmd run build`、`npm.cmd run example:mock`。

## English summary

siwc-bridge lets a local Windows Node.js app or agent harness use the signed-in user's own ChatGPT plan through OpenAI's official **Sign in with ChatGPT (SIWC)** and the public Responses API. It is an independent, free, open-source project for local use; it is not an OpenAI or DeepSeek product and implies no endorsement.

- Windows only (credentials are protected with Windows DPAPI). Node.js 24.
- `src/` is the reusable SDK; `integrations/dsh/` connects it to DeepSeek Harness (DSH).
- Each user signs in with their own account in the browser. Tokens stay on the user's PC and are never shared. No API key or paid fallback is used.
- Fast mode (`service_tier`) is not sent: SIWC documents no way to request it.
- **Billing caution:** depending on your ChatGPT settings, paid credits may be used after the plan allowance runs out. Before use, set the app's weekly limit below 100% or turn off credit use in ChatGPT Settings → Usage → App limits.
- Quick start for DSH: see the command block in [integrations/dsh/README.md](integrations/dsh/README.md). Documentation is in Japanese.

## 用途から選ぶ

| やりたいこと | 使うもの |
| --- | --- |
| Node.jsアプリ・ハーネスに接続を組み込みたい | このフォルダの汎用SDKと以下の導入・組み込み手順 |
| 実モデルを呼ばずにツール往復を確認したい | `npm.cmd run example:mock` |
| 既存DSHへ接続したい | 任意の接続例：[DSH用アダプター](https://github.com/Eureka-COM/siwc-bridge/blob/main/integrations/dsh/README.md) |

汎用化するのは接続コードです。組み込み先ごとに実際のアプリ名・独立した保存領域・本人の公式ログインを使います。同じ接続やトークンを別アプリへ使い回す設計ではありません。

## 同梱内容

| 場所 | 内容 |
| --- | --- |
| `src/` | 汎用SDK：認証、Windows保存、要求予算、モデル通信、公開型、CLI |
| `examples/` | ダミーファイルのread→結果返却→最終回答を確認するモック例 |
| `tests/` | SDKの合成テスト。DSHのテストは専用サブフォルダ内 |
| `docs/` | [配布・組み込みの条件](docs/DISTRIBUTION.md)、[公式仕様との照合](docs/COMPLIANCE.md)、設計・検証方針 |
| `scripts/` | Windows DPAPI helperとローカル配布物作成 |
| `.github/workflows/` | Windowsでのビルド・型検査・モックテスト |
| `integrations/dsh/` | 任意のDSH接続例：プラグイン、Web起動・導入・削除の専用手順 |

## 配布と公式条件

独自コードは[MIT](LICENSE)で配布しますが、ChatGPTサービスの利用条件は別です。無料のローカルOSS接続を対象とし、SIWCによるプラン利用を組み込み先アプリの有料購入・アップグレードの条件にしません。有料・リモート提供アプリでの利用は、[公式の申請案内](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt#usage-policy-and-terms)を確認してください。

[配布・組み込みの条件](docs/DISTRIBUTION.md)に、本人認証、アプリの境界、保存・同意・privacy notice、利用制限、ライセンスとブランドの扱いを記載しています。[SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)と一次資料を2026-10-09に照合しました。実装済みの対策と利用アプリ側の責任を分けて記録しており、すべての組み込み方の規約適合やOpenAIの承認を保証するものではありません。

## Windowsでの準備

検証環境はWindows 11、Node.js 24.13系です。資格情報の保存にWindows CurrentUser DPAPIを使うため、Windows以外には対応していません。SDK本体はDSHに依存しません。

GitHubのZIPを専用フォルダへ展開するか、次のコマンドで取得します。ZIPを展開した場合は、`package.json`があるフォルダで実行してください。

```powershell
git clone https://github.com/Eureka-COM/siwc-bridge.git
cd siwc-bridge
```

PowerShellでは`npm.cmd`を使います。実行ポリシーやCodex Appの設定を変更する必要はありません。

### SDKの導入

リポジトリの先頭フォルダで実行します。

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build
```

別の利用アプリへ導入する場合は、ここで`npm.cmd run release:local`を実行し、利用アプリのフォルダから`npm.cmd install --ignore-scripts <展開先>/artifacts/siwc-bridge-0.3.0.tgz`を実行します。`npm install siwc-bridge`によるレジストリ取得は提供していません。

## SDKの本人ログインと開始

次は汎用SDK用のCLIです。DSH用CLIとはコマンド・保存先が異なります。

```powershell
node lib/cli.js --app-id sample-local-app --app-name "Sample Local App" login
node lib/cli.js --app-id sample-local-app --app-name "Sample Local App" confirm
node lib/cli.js --app-id sample-local-app --app-name "Sample Local App" models
node lib/cli.js --app-id sample-local-app --app-name "Sample Local App" status
```

`appId`はアプリごとの保存先を分ける安定した識別子、`appName`は利用者に提示する実際のアプリ名です。自分のアプリの値に置き換えてください。Windows予約名などの不正な識別子は拒否します。

`login`の説明と**Continue with ChatGPT**から、本人が公式ブラウザでログイン・利用同意を行います。新規登録ではアプリ名を`agent_name_hint`に送り、検証済みの登録を保存します。再認証には`login <登録ID>`、本人の登録切替には`select <登録ID>`を使います。ログインだけでは推論を開始しません。`confirm`は初回のChatGPTプラン利用説明を確認する操作です。

既存Codex・ブラウザ・別アプリの資格情報は取り込みません。パスワード・Cookie・トークンをチャットへ貼り付けないでください。

### クレジット設定と要求予算

本人が[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage)で対象アプリの設定を確認します。この開始手順では、アプリ週間上限を100%未満、またはアプリのクレジット利用をOFFに保存して確認してください。自動購入OFFだけでは既存クレジットの消費を防げません。クレジット利用許可と自動購入は別設定です。[公式説明](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)も確認してください。

SDKはこの設定を取得・変更する私有APIを使いません。プラン枠だけを強制する公開推論引数も提供しません。`creditSettingsConfirmed: true`は本人の確認を表し、自動検証の結果ではありません。

```powershell
node lib/cli.js --app-id sample-local-app --app-name "Sample Local App" begin --max-requests 6
node lib/cli.js --app-id sample-local-app --app-name "Sample Local App" stop
```

`begin`は対話ターミナルで本人の`START`入力が必要です。予算は1〜1000要求で指定し、同じ`appId`の全プロセスで共有します。失敗したHTTP要求や、ツール結果を返した後の次の要求も数えます。モデル一覧取得は別計数です。新しい`begin`は現在の累計に指定した件数を加えた上限を設定します。

既定の推論はOFFです。利用枠エラー・予算到達・停止後は自動再開せず、本人の新しい開始操作が必要です。API従量課金・別アカウント・別providerへの自動切替はありません。

## 開発者向け：既存ループへの組み込み

ビルド済みのローカルパッケージを利用アプリへ導入し、次のように読み込みます。これは実モデルを呼ぶコード例です。本人のログイン・プラン確認・クレジット設定確認・開始操作を先に済ませてください。

```javascript
import { createWindowsClient } from 'siwc-bridge';

const runtime = createWindowsClient({
  appId: 'sample-local-app',
  appName: 'Sample Local App',
});

// auth.login(), auth.status(), auth.confirmPlan(), auth.select(), auth.signOut()
// を利用アプリの接続・設定 UI に結び付けます。
const models = await runtime.client.listModels(); // [{ id, name }]。id は公式 catalog の slug。
// 一覧から本人が選んだ id を使います。
const model = selectedModelSlug;

// 本人が設定を確認して開始した操作から呼びます。
await runtime.begin({ maxRequests: 2, creditSettingsConfirmed: true });

const tools = [{
  type: 'namespace',
  name: 'local',
  tools: [{
    type: 'function',
    name: 'read_dummy',
    description: 'Read the caller-owned dummy fixture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    strict: false,
  }],
}];
const input = [{ role: 'user', content: 'Read the dummy fixture using read_dummy.' }];
const response = await runtime.client.complete({ model, input, tools });

// reasoning を含む全 native item を、そのまま次の input に保持します。
input.push(...response.output);
for (const call of response.output) {
  if (call.type !== 'function_call') continue;
  // 呼び出し側の既存ループで、名前・namespace・引数・承認を確認して実行します。
  const output = await executeApprovedLocalTool(call);
  input.push({ type: 'function_call_output', call_id: call.call_id, output });
}
const finalResponse = await runtime.client.complete({ model, input, tools });
```

`selectedModelSlug` と `executeApprovedLocalTool` は利用アプリが用意します。`complete` は `{ model, output, usage? }` を返します。使用量が応答にない場合は `usage` を捏造しません。中断には `signal: AbortSignal` を渡せます。アプリ内の停止操作は `await runtime.stop()` に結び付けます。

下位の `SiwcClient` コンストラクタは資格情報源と必須の `RequestObserver.beforeRequest` を受け取り、呼び出し側が開始・予算・権限のポリシーを担います。独自のホストは `onUsageLimit` で共有の開始許可を持続的に無効化してください。`usageState` も渡すと、別プロセスで本人が開始し直したとき（世代番号が進んだとき）に、このプロセスの停止も解除されます。Windows アプリでの通常導入には、これらを組み込んだ `createWindowsClient` を使用してください。

独自の資格情報源を実装する場合、`withAccessToken` のコールバックの第3引数に、**そのトークンと同じ保存状態から読んだ登録ID**を渡してください。`status` を持つ資格情報源では、送信前にこの登録IDと会話履歴の登録を照合し、一致しない要求は送りません（v0.2.2）。登録IDを渡さない資格情報源は、新しい会話は使えますが、履歴の再利用は拒否されます。

native output と opaque reasoning の再利用は、同じ `SiwcClient`・同じアカウント登録・同じモデルの範囲です。同じプロセスでの JSON clone は利用できます。未知の暗号 reasoning をファイルへ保存して再起動後に復元する履歴は未対応です。別アプリ・別登録・別モデルへ opaque reasoning を移さないでください。会話履歴の保存や削減は呼び出し側が管理します。

再利用の照合情報は既定で最大4096項目です。下位コンストラクタの第3引数 `{ maxReplayItems: 8192 }` で1〜65536項目の範囲に設定できます。現在の入力履歴と新しい全出力はまとめて保持し、古い別会話の照合情報から除去します。現在の履歴だけで上限を超える場合は `REPLAY_CAPACITY_EXCEEDED` で失敗し、完了応答・ツールを返しません。このエラー時も、既に送った推論要求は予算へ計上されます。除去済みの履歴を再利用すると `INVALID_REPLAY_CONTEXT` になります。

会話終了時は `runtime.client.clearReplayHistory()` を呼び、利用アプリ側の履歴も破棄してください。この操作は実行中の要求も中断し、遅れて届いた応答で照合情報が復活することを防ぎます。`runtime.stop()` は推論の停止、`cancelRequests()` は実行中要求の中断であり、完了済み履歴を保持します。登録変更をクライアントが観測すると照合情報を破棄します。ホストがサインアウト・登録切替を行う際も、明示的に `clearReplayHistory()` を呼んでください。

SDK・DSHとも、エラー本文、モデル一覧、Discovery、JWKS、OAuthコード交換・refresh・失効確認の本文は読み込み中にUTF-8バイト数を数え、1 MiBを超えると読取を中断します。超過は `RESPONSE_TOO_LARGE`、本文は表示せず、有効なJSONの先頭だけを切り出して受理することもありません。HTTP実装が既に渡した1チャンクや内部バッファの割当量まで、この上限で制御するものではありません。SSEには既存の別のイベント・応答上限があります。

成功は正常な `response.completed` と完成済み項目の検査後に判定します。未完了・失敗・切断・矛盾した終端ではツールを返しません。終端の `output` が空でも、連続した全 index の完成済み `output_item.done` が揃った場合だけ native output を構築します。[仕様照合](docs/COMPLIANCE.md) に根拠と技術判断を記録しています。

利用アプリにはデータ処理前のprivacy notice、接続アカウント表示、初回プラン確認、利用中表示、[Manage usage](https://chatgpt.com/settings/usage)への導線を用意してください。[公式UI/UX指針](https://developers.openai.com/siwc/ui-ux-guidelines)を参照してください。SDKの`PRIVACY_NOTICE`は接続処理の説明例です。組み込み先の収集・送信・保存を含む必要な告知と同意は、利用アプリが用意します。[配布・組み込みの条件](docs/DISTRIBUTION.md)も確認してください。

## 停止・保存・削除

SDKの保存先は`%LOCALAPPDATA%\siwc-bridge\apps\<appId>`です。登録・host ID・資格情報・要求予算をアプリごとに分け、資格情報をCurrentUser DPAPIで保護します。別Windowsユーザー・別端末へ資格情報をコピーして再利用しません。

`stop`は持続する開始許可をOFFにし、自プロセスの進行中要求を中断します。他プロセスで送信済みの要求や使用量を取り消す操作ではありません。

```powershell
node lib/cli.js --app-id sample-local-app --app-name "Sample Local App" sign-out
```

`sign-out`は選択した接続のローカルトークンを削除し、公式のリモート失効を試みます。失効未確認なら、その旨を表示し、本人がChatGPTの接続設定からDisconnectします。登録とhost IDは再接続用に保持します。

全削除する場合は`stop`後に利用アプリの各プロセスを終了し、保存した各接続からサインアウトしたうえで、本人が対象`appId`の保存フォルダと導入ファイルを削除します。他アプリの保存領域は含めません。DSHの削除は専用READMEの手順に従ってください。

## 接続例：DeepSeek Harness

ソース配布物の`integrations/dsh/`には既存DSHへ接続する別パッケージを残しています。SDK本体にDSH依存はなく、SDK tgzにこのアダプターは含めません。DSH本体やAgent Loopを作り直さず、既存のツール実行とWeb UIを使う例です。

導入・本人ログイン・明示開始・Web起動・削除は[DSH用README](https://github.com/Eureka-COM/siwc-bridge/blob/main/integrations/dsh/README.md)を参照してください。上記のSDK CLIとはコマンドと保存先が異なります。DSHを使わない利用アプリでは、このサブフォルダの導入は不要です。

## 検証と対応範囲

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run example:mock
npm.cmd run release:local
```

通常テストとモック例は架空資格情報・合成SSEを使い、実ログインや実モデル要求は行いません。v0.3.0（2026-10-11）では、Windows上でSDK・DSH接続のテストがすべて成功し、DSH接続については本人のChatGPTプランで実際の通信による通しテスト（テキスト・ツール・複数ツール・サブエージェント・モデル切り替え・推論の度合い・画像/ファイル添付・中断）も成功しました。GitHub ActionsでもWindowsの検証を実行します。

**公式Usageへの計上・請求額の確認は、このリポジトリの検証には含みません。** 検証の範囲は[DSH接続の検証記録](integrations/dsh/docs/VERIFICATION.md)にまとめています。

SDKはテキストとローカルfunction tool向けです。SDKでの画像・音声・ファイル添付、hosted tools、backgroundなどは未対応です（DSH接続は画像・ファイルの添付に対応しています）。詳細な引数制約は[仕様照合](docs/COMPLIANCE.md)に記録しています。DSHのローカルreadはファイル添付とは別です。

`release:local`は`artifacts/`へソースZIP・ビルド済みSDKのtgz・内容一覧・SHA256を作成します。node_modulesやビルド生成物、個人状態、資格情報、ログはソースZIPに含めません。GitHubやnpmへ公開する操作ではありません。

## ライセンス

独自コードは[MIT](LICENSE)です。[NOTICE](NOTICE)と第三者依存のライセンスも確認してください。公式DevKitは公開APIに必要なツール入出力がないため採用せず、そのコード・文書・ブランド資産を配布物へコピーしません。

ソースのライセンスとOpenAIサービスの利用条件は別です。再配布時のライセンス・告知とSIWC利用条件は[配布・組み込みの条件](docs/DISTRIBUTION.md)を参照してください。previewのため、利用できるモデル・機能・利用枠はアカウントと現行仕様に依存します。
