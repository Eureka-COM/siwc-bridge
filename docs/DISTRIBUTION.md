# 配布・組み込みの条件

確認日: 2026-10-09 JST。対象は、本人がWindowsで動かすローカルNode.jsアプリへ組み込む汎用SIWC SDKです。DSHは任意の接続例です。本書は配布者・組み込み開発者向けの条件と確認範囲の案内であり、OpenAIの公認や法的適合の保証書ではありません。

## ソースの配布とサービス利用を分ける

独自コードは[MIT](../LICENSE)です。コピーや再配布には同ライセンスの著作権表示と許諾文を含め、[NOTICE](../NOTICE)の適用する告知を保持してください。依存を同梱する場合は、その依存のライセンス・必要な表示も保持します。MITはOpenAIサービス、第三者コード、商標・ロゴの利用権を付与しません。

公開のプラン利用フローはローカルOSS・個人プロジェクト向けです。有料アプリやリモート提供へ広げる場合は、提供開始前に[公式申請](https://openai.com/form/sign-in-with-chatgpt-interest/)から対象条件と利用許可を確認してください。このSDKのMITからサービス利用の許可を導くことはできません。[公式Overview](https://developers.openai.com/siwc/token-sharing-open-source)、[公式Cookbookの条件説明](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt#usage-policy-and-terms)

## SIWC利用時に守る条件

[SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)（2026-09-29版）の要点です。全文に加え、適用される[Terms of Use](https://openai.com/policies/row-terms-of-use/)、[Service Terms](https://openai.com/policies/service-terms/)、[Usage Policies](https://openai.com/policies/usage-policies/)を確認してください。

- 実際のアプリ名と本人の公式認証を使い、永続トークンは本人管理のローカル領域に保存する。
- 本人管理のruntimeから、本人の活動・明示した自動化だけを処理する。バックグラウンド処理には事前の明示同意が必要。
- 接続したアプリだけで使う。他アプリ向けの汎用API中継、トークン共有、他人の要求、利用枠回避に使わない。
- SIWCによる本人のプラン利用を、開発者への支払い・有料版へのアップグレードの条件にしない。
- 必要最小限のデータを処理し、処理前に適切なprivacy noticeと必要な同意・制御を用意する。利用者に影響する脆弱性・侵害は速やかにOpenAIへ連絡する。
- OpenAIの名前・ロゴ・ボタンは許された範囲で使い、公認や提携を示唆しない。

## SDKの対策と組み込み先の責任

| 境界 | SDKにある対策 | 利用アプリで必要な対応 |
| --- | --- | --- |
| アプリの識別 | `appId`ごとの保存先と実アプリ名の`appName`、公式登録 | 実際の名前を設定し、別アプリと保存先・接続を共用しない。SDKは名前の権利や本人性を審査しない。 |
| 本人認証・保存 | OAuth/OIDC検証、CurrentUser DPAPI、別アプリの資格情報を取り込まない | 接続を本人だけが使えるようにし、トークンや登録済み状態を配布物へ含めない。 |
| 推論開始・制限 | `createWindowsClient`の推論既定OFF、有限予算、停止・利用枠エラーの持続停止 | 本人操作に接続する。自動開始・別アカウントへの切替で制限を回避しない。下位`SiwcClient`では同等の開始・予算・停止ポリシーを実装する。 |
| データ・ツール | 通信・native tool call返却を担当し、ローカルツールは実行しない | 送るプロンプト・履歴・ツール結果を把握し、ツール権限・入力・ローカル実行・保存を管理する。 |
| 接続UI | 認証・初回確認・状態・サインアウトのAPI、説明用`PRIVACY_NOTICE` | 実際の処理に合う告知、接続アカウント、初回確認、利用中表示、Manage usage、停止・切断をUIへ結び付ける。 |

`PRIVACY_NOTICE`はSDKの接続処理の説明例であり、利用アプリ全体のprivacy noticeを代行しません。収集・送信・保存・削除と必要な同意をアプリの実態に合わせて説明してください。接続UIは[公式UI/UX指針](https://developers.openai.com/siwc/ui-ux-guidelines)、実装根拠は[COMPLIANCE.md](COMPLIANCE.md)を参照してください。

SDKの`auth.login()`は告知UIを自動表示しません。`appId`は保存先の識別子であり、同じWindowsユーザー内のアプリを隔離するセキュリティ境界ではありません。下位APIで認証トークンを扱う場合も、他アプリへの共有・送信を防ぐ責任は利用アプリにあります。

汎用なのは再利用できるコードです。アプリごとに本人が接続し、そのアプリの既存処理から使用します。全アプリ共通の登録済みトークンや共有サーバーによるプラン転売を提供するものではありません。

## DevKit・第三者資産

公式DevKitは採用・改変・同梱していません。本SDKは公開プロトコルの独立実装です。確認した[DevKit Noncommercial License v1.0](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/LICENSE)をMITへ置き換えていません。将来DevKitのコード・文書・資産を取り込む場合は、その時点のライセンスを別途確認してください。

DSH接続例は[専用NOTICE](https://github.com/Eureka-COM/siwc-bridge/blob/main/integrations/dsh/NOTICE)の依存・告知も適用します。DSHアダプターはソース配布物に収録し、SDK tgzには含めません。DSHを使わないSDK利用にDSHの導入は必要ありません。

## 公開物と確認の限界

公開前の検査は `npm.cmd run check:publication` でも行えます。現行ソースとnpmのdry-run候補を検査し、ZIP・tgzを生成しません。秘密情報ルールの正本は `scripts/publication-safety.mjs` です。DSH単独利用用に同一ファイルを同梱し、SDKテストでバイト一致を検証します。GitHub各種トークン、OAuth/APIキー/秘密情報フィールドのsnake_case・camelCase・JSONエスケープ、秘密鍵ヘッダーを検査します。長さ・形式に基づく候補検査であり、任意の分割・難読化された秘密をすべて検出するものではありません。

Windows CIは両package-lockの `npm audit`、Gitleaksによる全Git履歴検査、ビルド・型検査・通常テスト・公開候補検査を行います。Gitleaksは版と配布バイナリのSHA256を固定し、検出値をredactします。Secret scanningとPush protectionはGitHub側の機能なので、公開先の設定で別途有効を確認してください。これらの成功も完全な漏洩ゼロの証明ではありません。

`npm.cmd run release:local`で作るソースZIP・SDK tgzにはLICENSE・NOTICE・本書を含めます。生成処理は秘密情報候補と固定Windows絶対パス・UNCのバックスラッシュ表記・個人homeパス・file URIのパターンを検査し、ソースZIPから資格情報・登録状態・ログ・node_modulesを除外します。検査対象は現行のsource/npm候補であり、Git履歴や全秘密情報形式の検査ではありません。環境変数による保存先と相対パスは保持します。利用アプリ側で別の配布物を作る場合は、その追加ファイルも確認してください。

新SDKと公開DSH接続の実アカウント推論、公式Usageへの計上、クレジット不使用の実測は未確認です。モック・静的検査の成功を、これらの確認や規約承認の証明として扱いません。SDKの本人確認フラグはUsage設定を自動検証せず、クレジット消費を単独で保証しません。

公式仕様・利用条件・対象モデルは変更され得ます。公開・再配布・提供形態の変更時に一次資料を再確認し、利用アプリに必要な条件を満たしてください。
