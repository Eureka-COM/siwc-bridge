# 仕様照合と依存の採否

取得日: 2026-10-09 JST（2026-10-11 追記）。参照した公開資料・ソースは配布物へコピーしていません。本書は公認・規約適合・法的安全性の保証書ではありません。

実アプリ名は `SIWC Bridge for DSH`、保存先は `%LOCALAPPDATA%\siwc-bridge-dsh` の専用フォルダです。このリポジトリの検証では実ログイン・実モデル要求を行っていません。

公開版では、ChatGPT の利用上限・利用枠不明のエラーを受けた場合、共有要求記録の開始許可を OFF にし、停止前のモードを保存します。再起動や `/siwc resume` だけでは再開しません。本人が公式 Usage の設定を保存・確認し `/siwc resume confirmed`、または CLI `resume` で `START` を入力した場合にだけ、停止前のモードを復元します。要求累計をリセットせず、検証の6要求上限も保持します。未開始・使い切った検証は復旧で迂回しません。`live-test -- --begin` による新しい検証も、残りが2要求未満ならツール往復を開始しません。

| ID | 確認した一次資料と関連節 | 状態・実装対応 |
|---|---|---|
| S01 | [Overview](https://developers.openai.com/siwc/token-sharing-open-source) / client vs host、first inference | 確認済み。store.tsの永続UUIDv4 urn:uuid。推奨thumbprintは任意、UUIDは現行対応 |
| S02 | [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) / 1〜5 | 確認済み。auth.tsのdynamic_agent_client→issued client、nonce/state/PKCE、127.0.0.1、returned scope、identity一致 |
| S03 | [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) / accounts、refresh、end session、security | 確認済み。登録分離、CurrentUser DPAPI、FileShare.None排他、refresh/remote revocation、host mapping保持 |
| S04 | [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) / catalog、Responses、completed | 確認済み。adapter.ts固定public URL、models array/visibility/slug/order、protocol.ts完了判定 |
| S05 | [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) / requirements、tools、unsupported fields | 確認済み。allowlist、namespace、full history、system→developer、未対応引数拒否 |
| S06 | [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) / admission、structured errors、refresh | 確認済み。detail/structured分類、code/param/request ID、limit latch、retry0、終端失効だけtoken clear |
| S07 | [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) / response、lifetime | 確認済み。expires_in保存、refresh rotation、scope原子的更新。auth metadataは不透明 |
| S08 | [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) / first use、usage、in use、limit | 確認済み。index.tsの既存/siwc commands、初回confirm、公式Usageリンク。画面実機確認は未完了 |
| S09 | [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) / 2026-09-29版 | 確認済み。本人のlocal利用、無料配布、privacy notice、制限回避禁止。SIWC software改変の解釈を自己判断で確定しない |
| S10 | [DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit/tree/0a36fefeb913055c8c7a1a29b63d82b96b2e841a) / local types/responses/index/security | 確認済み。@siwc/local0.1.0、公開streamResponseはtextのみ。ツール不足で不採用 |
| S11 | [DevKit LICENSE](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/LICENSE) / v1.0 | 確認済み。非商用条件はSIWCサービス規約と別。DevKitを改変・転載・配布しない |
| S12 | [dsh source](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc) / README、AGENTS、SAFETY、adapter/agent/tool types | 確認済み。npm0.2.1-alpha.1のbuilt型とも照合。本体未変更 |
| S13 | [LLM adapter guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/llm-adapter) / registration、stream、model、packaging | 確認済み。ctx.llm.registerAdapter、外部bundle、正式profile/CLI |
| S14 | [ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) / permission、usage、limits、credits、disconnect | 確認済み。追加課金は本人設定。公式画面の実アカウント計上は未確認 |

選択方式は、公式公開OAuth/OIDCとpublic Responsesを独立実装し、標準crypto、維持されているjose、Windows DPAPIを使う方式です。DevKit公開APIにはtools・tool result・raw output・usageの入出力口がないため、未改変APIだけで初期要件を満たせません。private token/storeやprivate APIから不足を補いません。汎用proxy・別課金・新Agent Loopは作りません。

namespace／stream itemの型は[OpenAI公開SDK Responses types](https://github.com/openai/openai-node/blob/5e70623d6df4596bf39bcb9d2c93d8e8a50b856f/src/resources/responses/responses.ts)のNamespaceTool、ResponseFunctionToolCall、argument delta/done、output item、usageと照合しました。SDKは依存・コピーしていません。Context7の`/panva/jose`、`/deepseek-ai/deepseek-harness`、OpenAI API referenceも参照し、導入した版の実型を確認しました。

確認済みの仕様差: DevKit sendHostId既定falseは現行S01の送信必須に一致しないため、独立実装では毎認可に送信します。S06のforce_reconsentはintegration deployment確認が必要なので未採用、本人のenable-plan操作だけ現行prompt=consentを使います。earliest_refresh_atの型・単位はS07だけでは不明瞭ですが、公開DevKit index.tsはnumberをUnix秒、stringをDate.parseで処理します。同じ認識可能形式だけ受け入れ、未知形式で更新を停止します。

依存はjose6.2.12 MIT、host peers Cordis4.0.5-alpha.1/dsh0.2.1-alpha.1 MIT、build-only TypeScript5.9.3 Apache-2.0/@types/node24.19.1 MIT。registry出所・license・install scriptを確認し、lockを固定しました。dsh検証hostのtransitive依存にはMPL/LGPL等も含まれます。配布アーカイブへ依存binaryを混入せず、利用者のnpm導入時には各依存の元licenseが適用されます。独自コードのLICENSE/NOTICEは第三者コードやサービス利用権を再許諾しません。

630 lock項目でinstall scriptが宣言されたのはdsh-subprocess-local、google/genai、koffi、node-pty、protobufjs。manifestの役割を確認し、すべて--ignore-scriptsで導入しました。ソースdsh rootのhooksを書き換えるpostinstallは実行しません。公開候補にnode_modules・SDKソース・個人状態・ブランドassetは含めません。

未確認: 実アカウントでの推論、公式Usage画面での計上・クレジット残高・請求、実サービスのrefresh/失効の全ケース、別のWindowsユーザー/端末。ローカルテストの合格はこれらの保証になりません。

クレジットについて: S14の「Let apps use credits after reaching plan limits」は、アプリ上限100%未満でクレジット使用を防ぎ、クレジット利用許可と自動購入が別設定と明記します。利用者は公式 Usage の `SIWC Bridge for DSH` で自分の保存済み設定を確認します。公開推論引数にプラン枠だけを強制する項目はありません。設定を推測したり変更する私有APIを追加せず、本人確認を開始条件にします。利用計上と請求は別の未確認項目です。

Web署名secretは追加host peer `@deepseek-ai/dsh-credentials`0.2.1-alpha.1（MIT、公開CredentialProvider、install script無し）の9methodsを最小実装し、唯一のbrowser-session recordをprocessメモリで保持します。公開Web runtimeのprintUrl=falseを使用します。DPAPIのOAuth保存と分離し、再起動時の旧Web Cookie失効を確認します。

実サービスでの仕様差: 開発時に確認したpublic Responses HTTP/SSEでは完成済みoutput_item.doneの後、response.completed.outputが空配列でした。SDKの最終response集約例と同じと仮定せず、[公式Function calling Streaming](https://developers.openai.com/api/docs/guides/function-calling#streaming)のイベントから完成callを集約する手順と、公開SDKのreasoning item.done保持契約に基づいて独立クライアントを実装しました。技術判断として、空の終端配列の場合は連続した全indexの完成itemだけを使い、全schema・引数断片・call ID・opaque dataを検査し、正常response.completed後にだけツールを渡します。非空終端との不一致・missing done・failed・incomplete・切断は拒否します。本文やtokenを診断へ出しません。このリポジトリでの検証は合成 SSE を使うモックです。
