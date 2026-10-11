import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { createServices, PRIVACY_NOTICE, MANAGE_USAGE, CREDIT_NOTICE, startMessage, saveModel, statusText } from './admin.js';
import { safeFailure } from './errors.js';
import { resumeInference, startPersonalUse } from './ledger.js';

export const name = 'dsh-siwc-bridge';
export const inject = ['llm'];
/** Registers one provider, existing dsh slash commands, and input rejection. No tool executor. */
export function apply(ctx: Context): void {
  const { auth, adapter } = createServices();
  const registration = ctx.llm.registerAdapter(['siwc'], adapter);
  // A background catalog refresh that changed the list re-notifies the selector.
  adapter.onCatalogUpdated = () => registration.replace(['siwc']);
  ctx.effect(() => () => { adapter.cancelRequests(); auth.abortAll(); });
  // Public LlmRuntime.stream can also be called without an Agent. Reject raw
  // attachments before the host projects them into text at its adapter boundary.
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider === 'siwc' && options.messages.some(m => m.content.some(b => b.type !== 'text' && b.type !== 'tool-call' && b.type !== 'reasoning'
      && !((m.role === 'developer' || m.role === 'system') && (b.type === 'tool-addition' || b.type === 'tool-removal'))))) {
      throw new LlmError('SIWC初期版はテキストとローカルfunction toolの履歴だけに対応しています。添付は送信できません。', 'UNSUPPORTED_CONTENT');
    }
    yield* next();
  });
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (agent.options.provider === 'siwc' && messages.some(m => m.content.some(b => b.type === 'image' || b.type === 'file'))) {
      throw new LlmError('SIWC初期版は画像・ファイル添付に未対応です。テキストまたはdshのローカルreadを使用してください。', 'UNSUPPORTED_CONTENT');
    }
    return next();
  });
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next();
    if (config.provider === 'siwc' && agent.session.deriveMessages().some(m => m.content.some(b => b.type === 'image' || b.type === 'file'))) {
      throw new LlmError('保存された履歴に未対応の画像・ファイル添付があります。テキストだけの会話で使用してください。', 'UNSUPPORTED_CONTENT');
    }
    return config;
  });
  ctx.inject(['commands'], commandCtx => {
    let privacyShown = false;
    commandCtx.commands.register({
      name: 'siwc', description: 'ChatGPTプランの状態・公式ログイン・利用確認・モデル・Manage usage', recordInput: false,
      input: { hint: 'status | login | continue | confirm | models | model <slug> | select <registration> | sign-out | manage | resume [confirmed]' },
      handler: async ({ rawInput, signal }) => {
        const [action = 'status', value] = rawInput.trim().split(/\s+/);
        try {
          if (action === 'login') { privacyShown = true; return { kind: 'success', text: PRIVACY_NOTICE + '\nContinue with ChatGPT: /siwc continue（新規登録）または /siwc continue <保存登録ID>（再認証）' }; }
          if (action === 'continue') {
            if (!privacyShown) return { kind: 'error', text: 'ログイン前の説明を /siwc login で表示してください。' };
            adapter.cancelRequests();
            await auth.login({ registrationId: value, signal });
            return { kind: 'success', text: '認証結果を保存しました。登録を変更した場合は新しい会話を開始してください。初回のプラン利用確認: /siwc confirm\n' + await statusText(auth, adapter) };
          }
          if (action === 'confirm') {
            await auth.confirmPlan();
            const started = await startPersonalUse();
            return { kind: 'success', text: `You're using your ChatGPT plan. Got it.\nUsing ChatGPT plan / Manage usage: ${MANAGE_USAGE}\n${startMessage(started)}\n${CREDIT_NOTICE}` };
          }
          if (action === 'models') { const models = await adapter.listModelsFresh('siwc', signal); return { kind: 'success', text: models.map(m => `${m.id}: ${m.name}`).join('\n') }; }
          if (action === 'model' && value) { await saveModel(auth, adapter, value); return { kind: 'success', text: `選択を保存しました: ${value}。既存のdshモデル選択でSIWCの同じモデルを選択してください。` }; }
          if (action === 'select' && value) { adapter.cancelRequests(); await auth.select(value); return { kind: 'success', text: '登録を切り替えました。新しい会話を開始してください。\n' + await statusText(auth, adapter) }; }
          if (action === 'sign-out') { adapter.cancelRequests(); const result = await auth.signOut(signal); return { kind: 'success', text: result.remoteRevocation === 'confirmed' ? 'ローカルトークンを削除し、公式の失効応答を確認しました。' : `ローカルトークンを削除しました。リモート失効は未確認です。ChatGPT設定でDisconnectを確認してください。${MANAGE_USAGE}` }; }
          if (action === 'manage') return { kind: 'success', text: `Manage usage: ${MANAGE_USAGE}` };
          if (action === 'resume') {
            if (value !== 'confirmed') return { kind: 'success', text: `推論は再開していません。本人が ${MANAGE_USAGE} で対象アプリのクレジット不使用設定を保存・確認し、停止前の利用を再開する場合だけ /siwc resume confirmed を実行してください。検証予算の累計はリセットしません。` };
            await resumeInference({ settingsConfirmed: true }); adapter.resetUsageLimit();
            return { kind: 'success', text: '本人の設定確認・開始操作で停止前の利用を再開しました。検証の6要求予算と累計を保持しています。' };
          }
          if (action !== 'status') return { kind: 'error', text: '使い方: /siwc status | login | confirm | models | model <slug> | select <id> | sign-out | manage | resume' };
          return { kind: 'success', text: await statusText(auth, adapter) };
        } catch (error) { return { kind: 'error', text: safeFailure(error) }; }
      },
    });
  });
}
