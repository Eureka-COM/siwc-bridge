# Windows SIWC汎用化とGitHub公開

規模: 中（理由: 動作確認済みの専用接続から、認証・公開プロトコル・ハーネス境界を独立したNode.jsライブラリに分ける）。

## 目的と完了条件

WindowsのローカルNode.jsハーネスから、公式SIWCによる本人のChatGPTプランを利用できる独立クライアントを公開する。DSH本体・Agent Loop・現在の個人用DSH接続を変更しない。公開先は本人アカウントの新規 `Eureka-COM/siwc-bridge`。npm公開は行わない。

- DSHを依存に持たない公開クライアント、Windowsの専用DPAPI保存、本人の公式ブラウザログイン。
- アプリ名と保存namespaceをアプリごとに分け、別アプリや既存Codexの資格情報を取り込まない。
- モデルのツール呼出しを完了時に返し、利用側が既存のツールを実行して履歴へ結果を追加する。新しいAgent LoopやHTTP proxyは作らない。
- 完全な履歴、finished reasoning item、キャンセル、利用上限停止、推論再試行0。
- 既定の推論OFF、本人の設定確認と明示的な予算開始後のみ推論を許可。クレジット不使用は本人の公式Usage設定が必要。
- 通常テストと結合例はモックのみ。公開作業で新しい実推論・再ログインを行わない。
- Windows上のビルド、型検査、関連単体検査、公開APIのツール往復例、独立レビュー、秘密情報検査、配布内容監査を行う。
- GitHubへ公開後、remote commitと匿名読取、可能ならCI結果を確認する。実アカウント・クレジット計上の未確認を混同しない。

## 構成と公開インターフェース

`AuthManager` がアプリ専用の公式OAuth/OIDCとDPAPIを扱い、`SiwcClient` がpublic models/Responsesへの通信を扱う。会話とツールの型は独自の小さい型で公開する。呼出し側へ完成assistantメッセージと再利用状態を返し、次の要求で同じ履歴を渡せる。Windows以外の秘密ストアやモデル拡張は今回の範囲外。

## 検証と移行

`npm.cmd run build`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run example:mock`、`npm.cmd run release:local`。新規フォルダ・専用状態を使い、既存個人用接続から資格情報を移行しない。既存DSH向けの実測は出典を分けて記載し、汎用版の実アカウント成功として扱わない。

## 進捗

- [x] 認証・保存先と公開プロトコルの分離
- [x] 最小公開APIのモック往復とWindows検証
- [x] README・導入例・公開候補・監査・独立レビュー（SDK 40/40・DSH 53/53、モック結合・配布監査を確認）
- [x] GitHub公開とremote確認（Eureka-COM/siwc-bridge、mainのSHA一致・匿名README取得を確認）
