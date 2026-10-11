import { AuthManager, type AuthStatus } from './auth.js';
import { SiwcAdapter } from './adapter.js';
import { diskCatalogStore } from './local-cache.js';
import { recordRequest, verificationStatus, stopInference } from './ledger.js';
import { BridgeError } from './errors.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';
/** Shown at the first-use confirmation, which also starts ordinary use. */
export const CREDIT_NOTICE = `【課金の注意】プラン枠を使い切った後にクレジットを使う設定の場合、追加料金がかかることがあります。${MANAGE_USAGE} の App limits で「SIWC Bridge for DSH」の週間上限を100%未満にするか、クレジット利用をOFFにしてください。自動購入OFFだけでは既存クレジットの消費は防げません。`;
export function startMessage(result: 'started' | 'already' | 'stopped' | 'verification'): string {
  return result === 'started' ? '通常の個人利用を開始しました。'
    : result === 'already' ? '通常の個人利用を開始済みです。'
    : result === 'stopped' ? '利用上限のエラーで停止中です。公式Usageを確認してから resume で再開してください。'
    : 'ライブ検証の実行中です。終了する場合は finish-verification を実行してください。';
}
export const PRIVACY_NOTICE = 'この個人開発プラグインは、本人が許可したChatGPT登録情報をWindowsのCurrentUser DPAPIで保護してローカルに保存し、選択した会話履歴とdshのツール定義・結果をOpenAIの公開APIへ送信します。既存のChatGPT会話を取得しません。追加料金は本人のクレジット設定に従うため、ChatGPTのManage usageで確認してください。パスワード・Cookie・トークンをチャットへ入力しないでください。';
export function createServices() {
  const auth = new AuthManager(recordRequest);
  const adapter = new SiwcAdapter(auth, { beforeRequest: (kind, signal) => recordRequest(kind, signal), onUsageLimit: stopInference },
    { catalogStore: diskCatalogStore() });
  return { auth, adapter };
}
function selectionFile(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) throw new BridgeError('LOCAL_STATE_UNAVAILABLE', 'ローカル設定領域がありません。');
  return join(local, 'siwc-bridge-dsh', 'selected-model.json');
}
export async function saveModel(auth: AuthManager, adapter: SiwcAdapter, slug: string): Promise<void> {
  await adapter.resolveModel('siwc', slug);
  const status = await auth.status();
  const file = selectionFile();
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify({ model: slug, registrationId: status.activeId }), { encoding: 'utf8', mode: 0o600 });
}
export async function selectedModel(auth: AuthManager): Promise<string | undefined> {
  try {
    const row = JSON.parse(await readFile(selectionFile(), 'utf8')) as { model?: unknown; registrationId?: unknown };
    if (typeof row.model !== 'string' || row.registrationId !== (await auth.status()).activeId) return undefined;
    return row.model;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new BridgeError('MODEL_SELECTION_INVALID', 'モデル選択記録を確認できません。'); }
}
export function formatStatus(status: AuthStatus, model: string | undefined, limited: boolean): string {
  const rows = status.registrations.map(r => `${r.active ? '*' : ' '} ${r.id} ${r.label}: ${r.authenticated ? '認証済み' : '再認証が必要'} / ${r.planAllowed ? 'プラン利用許可済み' : 'プラン利用許可なし'} / ${r.planConfirmed ? '初回確認済み' : '初回利用確認が必要'}`);
  return ['ChatGPT plan (SIWC)', ...rows, `モデル: ${model ?? '未選択'}`, `利用上限: ${limited ? '新規推論停止。Manage usageを確認' : '未検出（残量は未確認）'}`, `Manage usage: ${MANAGE_USAGE}`].join('\n');
}
export async function statusText(auth: AuthManager, adapter: SiwcAdapter): Promise<string> {
  return formatStatus(await auth.status(), await selectedModel(auth), adapter.isUsageLimited()) + '\n要求件数: ' + JSON.stringify(await verificationStatus());
}
