# セキュリティ / Security

## 報告の方法

脆弱性や、資格情報・トークンが漏れるおそれのある不具合は、公開のIssueに書かないでください。GitHubの **Security → Report a vulnerability**（非公開の脆弱性報告）から連絡してください。

報告には、再現手順、影響、使っている版（コミットまたはタグ）を書いてください。**アクセストークン、リフレッシュトークン、IDトークン、Cookie、`credentials.dpapi` などの保存ファイル、ログの生データは送らないでください。** 必要な場合は値を `<REDACTED>` に置き換えてください。

このプロジェクトは個人による無償のオープンソースです。対応の期限や結果は約束できません。

## 対象

- `src/`（汎用SDK）と `integrations/dsh/`（DSH接続）のコード
- 公開している文書とスクリプト

ChatGPT、OpenAIのサービス、Sign in with ChatGPT、DeepSeek Harness自体の問題は、それぞれの提供元へ報告してください。

## Reporting (English)

Please do not open a public issue for a vulnerability. Use **Security → Report a vulnerability** on GitHub to report it privately. Never include access, refresh or ID tokens, cookies, `credentials.dpapi` or raw logs; replace any secret with `<REDACTED>`. This is an unpaid personal open-source project, so no response time is guaranteed.
