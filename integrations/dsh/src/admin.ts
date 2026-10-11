import { AuthManager, type AuthStatus } from './auth.js';
import { SiwcAdapter, type AdapterOptions } from './adapter.js';
import { diskCatalogStore, applicationDirectory } from './local-cache.js';
import { diskDiagnostics, type Diagnostics } from './diagnostics.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';
/** SIWC UI guideline: shown once, after the first sign-in with ChatGPT plan usage enabled. */
export const WELCOME = `You're using your ChatGPT plan — このアプリからのAI要求は、あなたのChatGPTプランの利用枠を使います。利用状況と上限はChatGPTの設定で管理できます（Manage usage: ${MANAGE_USAGE}）。`;
/** Billing caution shown with the welcome and in the README. */
export const CREDIT_NOTICE = `【課金の注意】プラン枠を使い切った後にクレジットを使う設定の場合、追加料金がかかることがあります。${MANAGE_USAGE} の App limits で「SIWC Bridge for DSH」の週間上限を100%未満にするか、クレジット利用をOFFにしてください。`;
export const PRIVACY_NOTICE = 'ChatGPTの公式画面でサインインと利用許可を行います。許可した登録情報はこのWindowsユーザーだけが読めるよう暗号化（DPAPI）して保存し、会話・ツール定義・ツール結果をOpenAIの公開APIへ送ります。パスワードやトークンをチャットに入力しないでください。';

export function createServices(media: Pick<AdapterOptions, 'attachments' | 'imageAccess'> = {}, diagnostics: Diagnostics = diskDiagnostics()) {
  const auth = new AuthManager();
  const adapter = new SiwcAdapter(auth, { catalogStore: diskCatalogStore(), diagnostics, ...media });
  return { auth, adapter, diagnostics };
}

/** Sign in, then show the first-use welcome once (the plan confirmation is recorded with it). */
export async function signIn(auth: AuthManager, options: { registrationId?: string; forceConsent?: boolean; signal?: AbortSignal }): Promise<string> {
  const before = await auth.status();
  const wasConfirmed = before.registrations.find(row => row.id === (options.registrationId ?? before.activeId))?.planConfirmed === true;
  const after = await auth.login(options);
  const active = after.registrations.find(row => row.active);
  if (!active?.planAllowed) return 'サインインしましたが、ChatGPTプランの利用が許可されていません。/siwc login をもう一度実行し、許可画面で利用を許可してください。';
  if (!active.planConfirmed) await auth.confirmPlan();
  return [wasConfirmed ? 'サインインしました。' : WELCOME, ...(wasConfirmed ? [] : [CREDIT_NOTICE]), 'モデルは入力欄のモデル選択から「ChatGPT plan (SIWC)」のモデルを選んでください。登録を切り替えた場合は新しい会話を始めてください。'].join('\n');
}

function selectionFile(): string { return join(applicationDirectory(), 'selected-model.json'); }
/** The model a new DSH start uses by default; choosing a model in the DSH selector works without it. */
export async function saveModel(auth: AuthManager, slug: string): Promise<void> {
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
  } catch { return undefined; }
}

export function formatStatus(status: AuthStatus, model: string | undefined, paused: boolean, diagnostics: string): string {
  const rows = status.registrations.map(r => `${r.active ? '*' : ' '} ${r.id} ${r.label}: ${r.authenticated ? 'サインイン済み' : 'サインインが必要（/siwc login ' + r.id + '）'}${r.authenticated && !r.planAllowed ? ' / プラン利用が未許可' : ''}`);
  return ['ChatGPT plan (SIWC) — Using ChatGPT plan', ...(rows.length ? rows : ['未サインイン: /siwc login で始めてください。']),
    `既定モデル: ${model ?? '未設定（入力欄のモデル選択で選べます）'}`,
    `利用上限: ${paused ? '上限に達したため停止中。確認後 /siwc resume' : '問題は検出していません（残量はChatGPTの設定で確認）'}`,
    `Manage usage: ${MANAGE_USAGE}`, `診断ログ: ${diagnostics}`].join('\n');
}
export async function statusText(auth: AuthManager, adapter: SiwcAdapter, diagnostics: Diagnostics): Promise<string> {
  return formatStatus(await auth.status(), await selectedModel(auth), adapter.isPaused(), diagnostics.location);
}
