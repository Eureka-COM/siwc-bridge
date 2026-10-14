# 仕様照合と依存の採否

取得日: 2026-10-09 JST（2026-10-11、2026-10-14 追記）。参照した公開資料・ソースは配布物へコピーしていません。本書は公認・規約適合・法的安全性の保証書ではありません。

実アプリ名は `SIWC Bridge for DSH`、保存先は `%USERPROFILE%\.siwc-bridge\apps\siwc-bridge-dsh` の専用フォルダです（v0.3.0 より前は `%LOCALAPPDATA%\siwc-bridge-dsh`。同じアプリの以前の保存場所からだけ、一度移します）。v0.3.0 では開発者のWindows PCで実ログイン・実モデル要求による通しテストを行っています（[検証記録](VERIFICATION.md)）。

利用上限（`subscription_sharing_usage_limit_exceeded`）を受けた場合、DSH接続はそのDSHプロセス内で新しい要求（推論・Web検索）を止め、Manage usage へ案内します。本人が確認して `/siwc resume` を実行すると再開します。この停止はプロセス内だけのもので、DSHを再起動すると解除されます。共有の要求記録・開始許可・要求数の上限による停止は SDK（`RequestBudget`）の機能で、DSH接続は使いません。

| ID | 確認した一次資料と関連節 | 状態・実装対応 |
|---|---|---|
| S01 | [Overview](https://developers.openai.com/siwc/token-sharing-open-source) / client vs host、first inference | 確認済み。store.tsの永続UUIDv4 urn:uuid。推奨thumbprintは任意、UUIDは現行対応 |
| S02 | [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) / 1〜5 | 確認済み。auth.tsのdynamic_agent_client→issued client、nonce/state/PKCE、127.0.0.1、returned scope、identity一致 |
| S03 | [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) / accounts、refresh、end session、security | 確認済み。登録分離、CurrentUser DPAPI、FileShare.None排他、refresh/remote revocation、host mapping保持 |
| S04 | [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) / catalog、Responses、completed | 確認済み。adapter.ts固定public URL、models array/visibility/slug/order、protocol.ts完了判定 |
| S05 | [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) / requirements、tools、unsupported fields | 確認済み。namespaceに入れたfunction tool、full history、system→developer。未対応の引数（temperature等）は送らずに続行（拒否しない）。ツール呼び出しは、今回の要求で提示した名前・同じnamespace・完了状態・JSONオブジェクトの引数が揃ったものだけを渡す（スキーマ全体の検査はDSHが行う） |
| S06 | [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) / admission、structured errors、refresh | 確認済み。detail/structured分類、code/param/request ID、利用上限ではプロセス内で停止。一時的な障害（5xx・切断・利用枠確認不能など）はDSHの再試行機能で最大4回、間隔を空けて再試行。終端失効だけtoken clear |
| S07 | [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) / response、lifetime | 確認済み。expires_in保存、refresh rotation、scope原子的更新。auth metadataは不透明 |
| S08 | [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) / first use、usage、in use、limit | 確認済み。index.tsの既存/siwc commands、初回confirm、公式Usageリンク。画面実機確認は未完了 |
| S09 | [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) / 2026-09-29版 | 確認済み。本人のlocal利用、無料配布、privacy notice、制限回避禁止。SIWC software改変の解釈を自己判断で確定しない |
| S10 | [DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit/tree/0a36fefeb913055c8c7a1a29b63d82b96b2e841a) / local types/responses/index/security | 確認済み。@siwc/local0.1.0、公開streamResponseはtextのみ。ツール不足で不採用 |
| S11 | [DevKit LICENSE](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/LICENSE) / v1.0 | 確認済み。非商用条件はSIWCサービス規約と別。DevKitを改変・転載・配布しない |
| S12 | [dsh source](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc) / README、AGENTS、SAFETY、adapter/agent/tool types | 確認済み。npm0.2.1-alpha.1のbuilt型とも照合。本体未変更 |
| S13 | [LLM adapter guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/llm-adapter) / registration、stream、model、packaging | 確認済み。ctx.llm.registerAdapter、外部bundle、正式profile/CLI |
| S14 | [ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) / permission、usage、limits、credits、disconnect | 確認済み。追加課金は本人設定。公式画面の実アカウント計上は未確認 |
| S15 | [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) / Supported tools（2026-10-12確認） | 確認済み。「Web search remains subject to model and account/workspace policy」。DSHの `web_search` を、検索専用の要求（hosted `web_search`、`tool_choice: required`、`store:false`、`stream:true`、`response.completed` で成功）で処理する。会話のターンにはhosted toolを送らない。方針により拒否された場合は、その旨を表示する |
| S16 | [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) / Inputs（2026-10-13確認） | 確認済み。「Text, images, and files work if the model accepts them」。`read_pdf` の結果に限り、PDFを `input_file`（`file_url` または `file_data`）として関数結果に添付する。拒否された場合は添付せずに一度だけ再送し、その会話では以後添付しない。Files upload APIは使わない |

選択方式は、公式公開OAuth/OIDCとpublic Responsesを独立実装し、標準crypto、維持されているjose、Windows DPAPIを使う方式です。DevKit公開APIにはtools・tool result・raw output・usageの入出力口がないため、未改変APIだけで初期要件を満たせません。private token/storeやprivate APIから不足を補いません。汎用proxy・別課金・新Agent Loopは作りません。

namespace／stream itemの型は[OpenAI公開SDK Responses types](https://github.com/openai/openai-node/blob/5e70623d6df4596bf39bcb9d2c93d8e8a50b856f/src/resources/responses/responses.ts)のNamespaceTool、ResponseFunctionToolCall、argument delta/done、output item、usageと照合しました。SDKは依存・コピーしていません。Context7の`/panva/jose`、`/deepseek-ai/deepseek-harness`、OpenAI API referenceも参照し、導入した版の実型を確認しました。

確認済みの仕様差: DevKit sendHostId既定falseは現行S01の送信必須に一致しないため、独立実装では毎認可に送信します。S06のforce_reconsentはintegration deployment確認が必要なので未採用、本人のenable-plan操作だけ現行prompt=consentを使います。earliest_refresh_atの型・単位はS07だけでは不明瞭ですが、公開DevKit index.tsはnumberをUnix秒、stringをDate.parseで処理します。同じ認識可能形式だけ受け入れ、未知形式で更新を停止します。

依存はjose6.2.12 MIT、host peers Cordis4.0.5-alpha.1/dsh0.2.1-alpha.1 MIT、build-only TypeScript5.9.3 Apache-2.0/@types/node24.19.1 MIT。registry出所・license・install scriptを確認し、lockを固定しました。dsh検証hostのtransitive依存にはMPL/LGPL等も含まれます。配布アーカイブへ依存binaryを混入せず、利用者のnpm導入時には各依存の元licenseが適用されます。独自コードのLICENSE/NOTICEは第三者コードやサービス利用権を再許諾しません。

630 lock項目でinstall scriptが宣言されたのはdsh-subprocess-local、google/genai、koffi、node-pty、protobufjs。manifestの役割を確認し、すべて--ignore-scriptsで導入しました。ソースdsh rootのhooksを書き換えるpostinstallは実行しません。公開候補にnode_modules・SDKソース・個人状態・ブランドassetは含めません。

未確認: 公式Usage画面での計上・クレジット残高・請求、実サービスのrefresh/失効の全ケース、別のWindowsユーザー/端末。実アカウントでの推論は開発者のPCで確認済みですが、ローカルテストや一度の通しテストの合格はこれらの保証になりません。

クレジットについて: S14の「Let apps use credits after reaching plan limits」は、アプリ上限100%未満でクレジット使用を防ぎ、クレジット利用許可と自動購入が別設定と明記します。利用者は公式 Usage の `SIWC Bridge for DSH` で自分の保存済み設定を確認します。公開推論引数にプラン枠だけを強制する項目はありません。設定を推測したり変更する私有APIを追加しません。初回サインイン時に、この設定を確認するよう一度だけ案内します（READMEにも記載）。利用計上と請求は別の未確認項目です。

Web署名secretは追加host peer `@deepseek-ai/dsh-credentials`0.2.1-alpha.1（MIT、公開CredentialProvider、install script無し）の9methodsを最小実装し、唯一のbrowser-session recordをprocessメモリで保持します。公開Web runtimeのprintUrl=falseを使用します。DPAPIのOAuth保存と分離し、再起動時の旧Web Cookie失効を確認します。

実サービスでの仕様差: ChatGPTプランの経路では、完成したitemは `output_item.done` で届き、`response.completed` の `output` は空配列でした。[公式Function calling Streaming](https://developers.openai.com/api/docs/guides/function-calling#streaming)のイベントから完成itemを集約します。成功は `response.completed`（response.statusが完了）を受けたときだけです。終端の `output` が空の場合は `output_item.done` で完成したitemを使い、開始したまま完成しなかったツール呼び出しがあれば、その応答のツールは渡しません。ツール呼び出しは、完了状態・このDSH接続のnamespace・今回提示した名前・JSONオブジェクトの引数がすべて揃ったときだけDSHへ渡し、1件でも欠ければその応答のツールをすべて渡さず（DSHの再試行に任せ）ます。引数の内容（スキーマ）の検査と実行の承認はDSHのツール実行側が行います。本文以外の通知は読み飛ばして種類名だけを診断ログに残し、本文やtokenは診断へ出しません。
