# dsh-siwc-bridge（SIWC Bridge for DSH）

OpenAIの公開SIWC仕様を利用する個人開発のdsh接続プラグインです。本人のWindows PCで、本人が利用を許可したChatGPTプランから公開Responses APIを呼び、既存DeepSeek HarnessのAgent Loopとローカルツールを使用します。OpenAI・DeepSeekの公式製品、公認・認定済みの製品ではありません。

このフォルダは [siwc-bridge](../../README.md) に含まれるDSH接続です。実ログイン・実モデル要求を伴う確認は、各利用者が自分の環境で行います。公式 Usage への計上・クレジット・請求は、このリポジトリでは確認していません。npm レジストリには公開していません。

## 最短手順（DSHで使う）

Windows 11、Node.js 24、Gitが必要です。PowerShellで実行します。

```powershell
git clone https://github.com/Eureka-COM/siwc-bridge.git
cd siwc-bridge\integrations\dsh
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build
npm.cmd run setup              # 専用のDSH環境へ導入
node lib/cli.js login          # ブラウザで本人がログイン・利用を許可
node lib/cli.js confirm        # 初回のプラン利用確認（ここで利用を開始）
node lib/cli.js models         # 使えるモデルの一覧
node lib/cli.js model <slug>   # 一覧から1つ選ぶ
npm.cmd start                  # DSHの画面を開く
```

使い始める前に、下の「使う前の注意（課金）」を確認してください。

## ⚠ 使う前の注意（課金）

ChatGPTの設定によっては、**プランの利用枠を使い切った後に、有料のクレジットが自動で使われる**ことがあります。使い始める前に、[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) の **App limits → SIWC Bridge for DSH** で、週間上限を100%未満にするか、クレジット利用をOFFにして保存してください。自動購入をOFFにするだけでは、すでにあるクレジットの消費は防げません（[公式の説明](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)）。

アプリ名「SIWC Bridge for DSH」は、最初のログインの後にUsageの一覧へ表示されます。利用上限のエラーを受けたときは推論を止め、`resume` を実行するまで再開しません。

## 前提と確認した版

検証対象は Windows 11、Node.js 24.13.0 です。dsh `0.2.1-alpha.1`、確認した公開ソースcommit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。jose `6.2.12`、TypeScript `5.9.3`。依存はpackage-lock.jsonに固定しています。

検証hostの依存監査で見つかったMCPクライアントとZIP展開の既知問題に対し、開発用依存を `@modelcontextprotocol/client` 2.2.0、`fflate` 0.8.3へoverrideしてlockに固定しています。この設定は本フォルダをrootとして導入する検証環境に適用されます。npmの依存package側のoverrideは導入先へ伝播しないため、既存dshへプラグインだけを追加する場合は、そのhostの依存も別途監査してください。[公開前の検査](../../docs/DISTRIBUTION.md)も参照してください。

dshはdeveloper previewです。[公式安全上の注意](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/SAFETY.md)を読んでください。read-only設定は読取範囲のOS隔離を保証しません。検証時は既存tool guardでダミーファイル1個のreadだけを許容します。普段の利用ではdshの既存承認・権限設定を確認してください。

## 導入

ソースアーカイブを専用フォルダへ展開し、そのフォルダで実行します。npm.ps1が署名制限で動かない環境はnpm.cmdを使用してください。グローバル設定・実行ポリシーを変更する必要はありません。

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build
npm.cmd run typecheck
npm.cmd test
npm.cmd run setup
```

setupは`.work/dsh-home`に専用`siwc-web`プロファイルを作り、ローカルtgzを公式`dsh plugin add`で登録します。既存のCodex設定や既存dshプロファイルを変更しません。依存install scriptを止め、別モデル経路・会話タイトル推論・テレメトリを専用overlayで停止します。ネットワークが必要なのは公開依存の取得です。通常testのモデル通信はモックのみです。

Web接続用の署名鍵は公開CredentialProviderを使うメモリ専用サービスへ保存し、平文ファイルを生成しません。SIWC資格情報とは別です。Web再起動時には旧Cookieが無効になり、dshが開く新しいブラウザ接続を使います。秘密を含むlaunch URLの標準出力を停止しています。

## 本人ログインとモデル選択

```powershell
node lib/cli.js login
node lib/cli.js confirm
node lib/cli.js models
node lib/cli.js model <一覧のslug>
node lib/cli.js status
```

`confirm`（DSH画面では `/siwc confirm`）は初回のプラン利用確認で、同時に通常の個人利用を開始します。確認の結果に課金の注意を表示します。`confirm` の前の推論は、すべて送信前に止まります。利用上限のエラーで停止した後は `confirm` では再開せず、`resume` を使います。要求件数は記録を続け、リセットしません。v0.2.0の `begin` は互換のために残しており、同じく利用を開始します（`START` の入力は不要になりました）。

ログイン前にprivacy noticeを表示し、起動済み127.0.0.1のcallbackへ公式ブラウザから戻ります。本人がブラウザでログイン・workspace選択・登録・利用同意を行ってください。パスワード、Cookie、コード、トークンをチャットや設定へ貼り付けません。ログインだけではライブ推論を開始しません。

利用許可がなければ推論は送信しません。保存済み登録で許可し直す場合は`node lib/cli.js enable-plan <登録ID>`。再認証は`login <登録ID>`。別アカウント・workspaceを追加する場合は引数なしのloginで専用登録を作り、`select <登録ID>`で本人が明示選択します。emailで登録を統合せず、勝手に別登録へ切り替えません。

登録を切り替えたら新しい会話を開始してください。内部履歴には元の登録IDを含むv2の再利用情報を保存し、送信時の登録と照合します。別登録由来、登録を記録していない旧v1履歴は、モデルが同じでも異なっても `INVALID_REPLAY_CONTEXT` で送信前に拒否します。旧会話を自動移行・削除せず、由来を推測して内部履歴を再送しません。同じ登録のv2会話は再起動後も再利用でき、同じ登録でのモデル変更は既存の明示テキスト・呼出し・結果を保持して旧モデルのopaque reasoningを外します。独自CredentialSourceで内部履歴を再利用するには、`status(signal)`のactiveIdと、`withAccessToken`がコールバック第3引数で渡すトークンに対応した登録IDが必要です。登録由来が不明な場合にアダプターIDやトークン値で代用せず、内部履歴の再利用を拒否します。

エラー、モデル一覧、認証関連のJSON本文は[SDKと同じ1 MiBの受信中制限](../../README.md)を使います。超過時は読取をキャンセルし、本文を表示しません。失効確認に失敗したサインアウトも、ローカルトークンの削除は行います。

公式ログインへ提示する実アプリ名は `SIWC Bridge for DSH` です。資格情報と永続host IDは`%LOCALAPPDATA%\siwc-bridge-dsh\credentials.dpapi`にCurrentUser DPAPI＋owner ACLで保存します。モデル選択と要求記録も同じ専用フォルダに保存します。公開版では新しい本人ログインとモデル選択が必要です。平文fallbackはありません。資格情報はGit領域・配布物へ保存しません。OS間排他・atomic replaceで回転refreshを保護します。

## 小規模ライブ検証

通常の利用には不要です。最大6要求の小さな実モデル往復で動作を確かめたい場合だけ使います。このリポジトリの検証では実行していません。

[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage)で本人がプラン・アプリの上限を確認した後、対話ターミナルで実行します。当面はサブスクリプション枠だけを使います。App limits → SIWC Bridge for DSH → Manage limitsで週間上限を10%など100%未満に保存するか、アプリのクレジット利用をOFFに保存し、保存済みの値を確認してください。[公式説明](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)では100%未満のアプリ上限はクレジット使用を防ぎます。自動購入OFFだけでは既存クレジット消費を防げません。

公開SIWCにはプラン枠限定のリクエスト引数やUsage設定を読む・変更する公開APIがありません。プラグインは架空の課金指定を送りません。本人の設定確認が終わるまでライブはOFFです。設定を後で変更すると条件も変わるため、開始前に毎回確認してください。

```powershell
npm.cmd run live-test -- --begin
```

確認文へ`START`と入力すると開始します。ログイン・初回プラン確認・モデル選択が未完了なら送信しません。6推論HTTP要求の予算を全プロセス共通のローカル記録で計数し、失敗・次のtool結果推論も1件に数えます。認証・モデル一覧は別件数です。毎scenarioは2ステップ・read1回・60秒で停止します。実モデルへ非対応max_output_tokensを送りません。

テストは専用ダミーworkspaceの小ファイルを実dshのreadで読み、プロンプトに渡していない値を最終回答へ返すケースです。`.work/verification/live-*`に個人用証跡を残します。公開用アーカイブには含めません。モック成功、実応答成功、公式画面での計上は別判定です。計上確認には公開Usage画面を使用し、非公開APIを探索しません。

`npm.cmd run live-test`だけではOFF表示になり、モデルを呼びません。Webからの直接推論も開始前は拒否します。非対話での`--begin --settings-confirmed --plan-only-confirmed`は本人がクレジット不使用設定を保存・確認済みとして明示的に開始する用途に限ります。検証完了後に通常個人利用へ進む場合だけ、本人が`node lib/cli.js finish-verification`を実行します。利用枠エラーで停止した検証や6要求を使用済みの検証も、本人が公式 Usage の設定を確認してからこの終了操作を行えます。要求累計は保持します。未開始状態や通常個人利用の停止には、この操作で開始・再開の許可を与えません。これは今回の検証予算の終了であり、公式利用上限を変更しません。

## 使用

```powershell
npm.cmd start
```

専用dsh Web UIの既存モデル選択で`ChatGPT plan (SIWC)`を使います。`/siwc status`に認証・プラン許可・初回確認・モデル・上限状態とManage usageを表示します。`/siwc login`で説明を表示し、`/siwc continue [登録ID]`で公式ログイン。`/siwc confirm`は初回利用確認、`/siwc models`はアカウント別一覧、`/siwc manage`は公式管理リンクです。

認証したアカウントで一覧に表示されたslugを使用します。モデル世代、Pro専用モデル、context長を固定値で提供しません。ツールはdshが実行します。簡単な例は「専用フォルダのexample.txtをreadで読み、内容を短く説明して」です。

### モデル一覧と読み込み

モデル一覧は表示用の情報として扱います。[SIWCの公式ドキュメント](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)は、一覧を利用資格の確認ではないとし、選んだモデルを使えるかは推論の完了で確かめるとしています。

- 取得した一覧（slugと表示名だけ）を登録ごとに `%LOCALAPPDATA%\siwc-bridge-dsh\model-catalog.json` へ保存します。次回はこの一覧をすぐ表示し、裏で1回だけ最新化します。内容が変わったときだけ画面の一覧を更新します。
- 同じ登録の一覧はメモリ上で10分再利用し、期限後は表示を続けながら裏で最新化します。ログイン・プラン許可・初回確認がそろっていない登録や、別の登録では再利用しません。
- 推論の送信前に一覧を取り直しません。使えないモデルはサービスの応答（例: `model_not_found`）で停止し、自動再送しません。`/siwc models` は常に新しい一覧を取得します。

資格情報は書き込みとトークン更新のときだけOSロックを取ります。読み取りだけの処理（状態表示、有効なトークンでの要求）はロックを取らず、暗号化ファイルが変わっていなければ復号済みの内容をプロセス内で再利用します。ACL設定も対象が変わったときだけやり直します。偽の資格情報と模擬通信での計測では、1回の送信前後の待ち時間が約7秒から約0.03秒になりました。プロセスで最初の読み取りだけは復号のため0.5〜1秒ほどかかります。

### 推論の度合い

確認済みの完全一致slugだけに、[OpenAIの公式モデル仕様](https://developers.openai.com/api/docs/models/gpt-6.1-sol)にある推論の度合いを既存のモデルメニューへ表示し、選択を`reasoning.effort`へ変換します。GPT-6.1-SolとGPT-6-Astraはlow・medium・high・xhigh・max、GPT-6-Sol/LunaとGPT-5.6-Sol/Terra/Lunaはこれらにnoneを加えた候補です。未指定ではeffortを送らず、未知のモデルには候補を作りません。SIWCのモデル一覧自体は推論候補を保証しません。

### 速度（Fast）は使えません

SIWC経由のChatGPTプラン利用には、Fast（優先処理）を指定する公式の方法がないため、このアダプターは速度の指定（`service_tier`）を送りません。Fastが案内されているのはOpenAIのCodexアプリ・CLI・IDE拡張にChatGPTでサインインした場合で（[Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed)）、SIWCの[Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)はservice tierの指定を未対応機能の例に挙げています。2026-10-11の確認では、`"fast"` はHTTP 400で拒否され、`"priority"` は受理されても応答が通常処理（`service_tier: "default"`）でした。速くしたい場合は推論の度合いを下げるか、一覧の軽いモデルを選んでください。

エラー表示には安全な分類に加えて `http=<状態コード>` と `request_id=<ID>` を添えます。サービスの本文は秘密を含み得るため表示しません。

## 対応範囲と停止

対応はテキスト会話、namespace内のローカルfunction tool、tool結果・履歴・不透明なreasoning itemの返却、SSE、usageがある場合の変換、キャンセルです。成功にはresponse.completedが必要で、途中切断・failed・incomplete・不正JSONではtoolを実行しません。

画像・音声・ファイル添付、hosted tools、background、temperature、top_p、max_output_tokens、previous_response_idなどは未対応です。明示指定は送信前にエラーにします。dshのローカルreadはファイル添付とは別です。

401は認証・許可を確認、403は資格・地域・policyを確認、ChatGPT の利用上限・利用枠不明のエラーは新規推論停止、503は資格情報を保持して本人が後で再実行します。利用枠エラーの停止は専用要求記録へ保存し、Web や別プロセスの再起動だけでは解除しません。推論の自動再試行は0回。失効の一時障害だけ有限2試行です。上限の種類・復旧時刻は推測しません。`/siwc resume` だけでは再開しません。本人が公式 Usage のクレジット不使用設定を保存・確認した後、`/siwc resume confirmed` または対話ターミナルで `node lib/cli.js resume` の `START` 入力を行うと、停止前の検証／通常個人利用モードを復元します。要求の累計はリセットせず、検証の6要求上限も保持します。開始したことのない状態や、6要求を使い切った検証の再開は拒否します。新しい検証は `npm.cmd run live-test -- --begin` で開始し、残りが2要求未満ならツール往復を開始できません。APIキー従量課金・別アカウント・別providerへのfallbackはありません。追加料金の有無は本人のクレジット設定によります。

## ログアウト・削除・再導入

```powershell
node lib/cli.js sign-out
npm.cmd run remove:plugin
npm.cmd run setup
```

sign-outは稼働要求を中断し、公式失効を試してローカルトークンを削除します。登録とhost IDは残します。remote revocation未確認ならその旨を表示します。公式connectionの解除はChatGPTのSecurity and login → Login connections → Sign in with ChatGPT → Disconnectです。

remove:pluginは専用のsiwc-web・siwc-liveプロファイルのプラグイン登録とパッケージ依存を公式CLIで解除します。個人証跡とDPAPI状態は自動削除しません。全削除したい場合はまずsign-outと公式Disconnectを確認し、自分の対象だけを確認して公開版の専用プロジェクトと`%LOCALAPPDATA%\siwc-bridge-dsh`を削除してください。汎用 SDK など他の保存領域は対象に含めません。host IDを消すと次回は新しいインストールになります。

## ローカル配布物

```powershell
npm.cmd run build
npm.cmd run release:local
```

`artifacts/`のsource.zipは独自ソース・設定・lock・架空テスト・手順、tgzはbuilt pluginと文書・DPAPI helperを含みます。内容一覧・SHA256も作成します。このコマンドはローカル配布物だけを作成し、GitHub や npm へ公開しません。node_modules、実状態、認証、証跡、ユーザーパスを含めません。依存は取得先の元ライセンスで別途導入します。独自コードのMITとSIWCサービス規約は別です。

一次資料・採否は[docs/COMPLIANCE.md](docs/COMPLIANCE.md)、実測と未確認は[docs/VERIFICATION.md](docs/VERIFICATION.md)を参照してください。公開候補と個人利用の検証は、他の利用者や公式の計上画面での成功を保証しません。
