# 公開仕様との照合

取得日: 2026-10-09 JST。本書は独立実装の技術判断と確認範囲を記録します。公認、規約適合、所有権、法的安全性の保証書ではありません。個人の登録情報・資格情報・PC 状態や公開一次資料のコピーは配布物に含めません。

配布者・組み込み開発者向けの条件と、SDKの対策だけでは完結しない責任は[配布・組み込みの条件](DISTRIBUTION.md)を参照してください。汎用SDKが主製品で、DSHは独立した接続例です。

## 参照した一次資料

| 資料 | 確認した内容・実装条件 |
|---|---|
| [SIWC Overview](https://developers.openai.com/siwc/token-sharing-open-source) | OSS/local runtime 用の公開フロー。有料・リモート提供アプリは公式申請の対象。client と host は別識別子。host ID は不透明で安定し、UUIDv4 の `urn:uuid:` が対応形式。JWK thumbprint 推奨は任意。 |
| [SIWC Cookbook: Usage policy and terms](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt#usage-policy-and-terms) | ローカルOSS・個人プロジェクト向け。有料・リモート提供は提供前に申請する案内。配布前の規約・ポリシー確認と、DevKit採用時のライセンス確認を区別。 |
| [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | 初回は `dynamic_agent_client` と実アプリ名の `agent_name_hint`。再認証は issued client ID を使い、name hint を省略。127.0.0.1 loopback、state/nonce/PKCE、ID token の署名・iss/aud/nonce/exp・本人 identity の一致、returned scope の確認。 |
| [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | 登録・アカウント・workspace を分離。アクティブ接続を表示。refresh rotation、リモート失効とローカル削除を区別し、失効確認なしで成功と表示しない。 |
| [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | 本人の `GET /v1/models` catalog、visibility/order/slug、固定 public `POST /v1/responses`、`store:false` と `stream:true`、正常 `response.completed` まで読む。 |
| [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | namespace 内の function/custom tools と必要な full input。system メッセージは developer へ正規化し、明示 system item を送らない。未知の機能・非対応推論引数を別経路で補わない。 |
| [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) | admission error と structured error、利用上限・利用枠不明・権限不足・refresh 失敗を区別。自動課金・別アカウント切替・無制限の再試行をしない。 |
| [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) | expiry・granted scope・rotating refresh token の原子的保存。認証 metadata を不透明に扱う。 |
| [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) | Continue with ChatGPT、初回プラン利用説明、接続アカウント・利用中表示、Manage usage、利用上限時の案内。利用アプリ側の UI に結び付ける。 |
| [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | 2026-09-29 版。実アプリ名、本人管理 runtime、本人の要求・明示した自動化、接続したアプリだけの利用、無料での SIWC 利用、処理前 privacy notice、最小限のデータ処理、制限回避・共有・なりすまし禁止。 |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Usage 設定、アプリ上限、クレジット利用 opt-in、自動購入との区別、Disconnect。本人の設定確認を推論開始条件にする。 |
| [Official DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit/tree/0a36fefeb913055c8c7a1a29b63d82b96b2e841a) / [公開型](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/packages/local/src/types.ts) | 現行 main は既確認 commit と identical。`@siwc/local` 0.1.0/private。公開 streamResponse は text 入出力と onDelta のみ。tools・tool result・raw output・usage の公開口がないため不採用。 |
| [DevKit LICENSE](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/LICENSE) | Noncommercial License v1.0、前回取得から変更なし。商用利用・再配布・改変の条件、第三者資産・商標・サービス権との区別を確認。コードや資産をコピー・改変・再配布しない。 |

公開 OAuth の登録フィールドに `appURL` や独自 User-Agent が必須との記載は確認できませんでした。独自 User-Agent に実アプリ名、version、公開 URL を付ける場合は実装上の attribution として扱い、SIWC の本人 identity や登録 ID と混同しません。

## アプリごとの境界

SDK の再利用性は、他のアプリへ同じ接続やトークンを配ることを意味しません。各利用アプリは実際の `appName`、安定した `appId` と保存領域、本人の公式ログインを使います。SDK は汎用 HTTP proxy や別アプリへの資格情報の自動取り込み・配布用CLIを提供せず、接続した本人・アプリの要求だけを送る用途です。下位APIで受け取るトークンを他アプリへ共有・送信しない責任も利用アプリにあります。

保存先は `%LOCALAPPDATA%\siwc-bridge\apps\<appId>`。不正な識別子・制御文字・Windows 予約名を拒否し、資格情報を CurrentUser DPAPI で保護します。既存 Codex、ブラウザ、他アプリの保存領域を探索・読取・移行しません。登録 ID、verified identity、returned scope、expiry、回転した token を整合させて保存し、ログに出しません。

モデルの native tool call を返すことと、ツールを実行することは別です。SDK は実行せず、利用アプリの既存ループが許可・引数・ローカル実行を管理します。アプリを横断する接続共有や、別人の要求の処理に利用しません。

## ストリームと履歴の技術判断

[公式 Function calling の Streaming 節](https://developers.openai.com/api/docs/guides/function-calling#streaming) は、stream event から function call を集約する例と `output_item.done` の完成 item を公開しています。[OpenAI 公開 SDK の Responses 型](https://github.com/openai/openai-node/blob/5e70623d6df4596bf39bcb9d2c93d8e8a50b856f/src/resources/responses/responses.ts) は namespace、argument delta/done、native item、usage を定義し、reasoning の次回入力には item.done の完成済み encrypted content を使用するよう記述しています。SDK のコードは依存・転載していません。

開発時の実サービス確認では、public Responses SSE に完成済み `output_item.done` があり、正常 `response.completed.output` は空配列でした。「空の終端配列なら途中項目を復元する」という明文の保証は確認していません。公開された完成 item と正常終端の契約を利用する独立クライアントとして、次の技術判断を採用しています。

- 終端配列が空の場合だけ、連続した全 index の完成済み done item を使う。
- 全項目の型・完了状態・call ID・namespace・許可された tool・JSON 引数・引数断片の一致を検査する。
- 非空終端配列がある場合は観測した項目との一致を検査し、開始済み項目の欠落や変更を許さない。
- 正常 response.completed 後にだけ tool を返し、error/incomplete details がある矛盾した終端、missing done、failed、incomplete、切断を拒否する。
- reasoning を含む全 native output の内容と順序を保持し、usage がない場合は値を捏造しない。

新 SDK の再利用範囲は同一 `SiwcClient`・同一登録・同一モデルです。同一プロセスでの JSON clone は対応します。未知の暗号 reasoning のファイル保存・再起動後の履歴復元は未対応です。変更した履歴や別モデルへ不透明データを黙って再投入する手順は提供しません。

## 推論の開始、予算、クレジット

通常テストは合成資格情報・合成 SSE とモックを使用し、実モデルを呼びません。推論は既定で停止し、本人が設定を確認して明示した開始操作から、1〜1000 の整数の `maxRequests` と `creditSettingsConfirmed:true` で開始します。予算はアプリ固有の `requests.json` に保存し、同一 `appId` の全プロセスで共有します。モデル HTTP 要求の直前に、失敗した要求やツール結果後の要求も数えます。モデル一覧は推論件数に含めません。

`begin` は現在の要求数に指定予算を加えた有限上限を許可し、利用枠エラーのクライアント側停止を本人操作で解除します。ChatGPT 自体の利用枠を回復させる操作ではありません。`stop` は持続する新規要求の許可を無効にし、自プロセスの要求を中断します。他プロセスで送信済みの要求を遡及撤回しません。上限・停止・利用枠エラーからの自動再開はありません。下位 `SiwcClient` を直接使用する場合は、必須の request observer を通じて利用アプリが同等のポリシーを担います。

`creditSettingsConfirmed` は本人確認の記録で、ChatGPT 設定の自動検証ではありません。S14 の現行説明では、クレジット許可は既定 off、アプリ上限 100% 未満はクレジット利用を防ぎ、100% だけでは利用許可を有効にしません。クレジット利用と自動購入は別です。本人に公式画面の保存済み設定を確認してもらい、公開されていない設定 API や推論引数で不足を埋めません。

## ライセンスと確認範囲

独自ソースは MIT、jose 6.2.12 は MIT、開発用 TypeScript 5.9.3 は Apache-2.0、`@types/node` 24.19.1 は MIT です。第三者依存・OpenAI ブランド・サービスにはそれぞれの条件が適用されます。DevKit License は独立ソフトが interface を通じて通信するだけで Modified Work になるわけではないと定義しますが、その条項から本リポジトリの所有権やサービス利用の法的保証を導きません。

SDK 本体は dsh に依存しません。[dsh 専用 integration](https://github.com/Eureka-COM/siwc-bridge/tree/main/integrations/dsh) はソース配布物の別のサブフォルダとして扱い、その dsh 依存・導入・検証範囲を同フォルダで記録します。SDK tgzには同梱しません。公開候補に個人の credential、PC 状態、ログ、元 SDK ソースやブランド asset を混入させません。

新 SDK の実アカウント推論、実サービスの refresh/失効の全ケース、別の Windows ユーザー・端末、公式 Usage・請求への計上は未確認です。公開前の build/test/配布物検査の実行結果は別に記録し、未実行の確認を成功扱いにしません。
