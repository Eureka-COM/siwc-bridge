import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { createServices, defaultModel, signIn, saveModel, statusText, MANAGE_USAGE, PRIVACY_NOTICE } from './admin.js';
import type { ImageSource } from './adapter.js';
import { safeFailure } from './errors.js';
import { SiwcSearchProvider, type WebSearchProvider } from './web-search.js';

export const name = 'dsh-siwc-bridge';
export const inject = ['llm'];

const HELP = '/siwc [status] | login [登録ID] | models | model <slug> | select <登録ID> | sign-out | manage | resume | diagnostics';

/**
 * One model provider ("ChatGPT plan (SIWC)"), one web search provider for DSH's own
 * `web_search` tool, and one slash command. Everything else is DSH's own behaviour.
 */
export function apply(ctx: Context): void {
  const service = <T>(name: string) => (ctx as unknown as { get(name: string): T | undefined }).get(name);
  const { auth, adapter, diagnostics } = createServices({
    // Resolved per request: the attachment and filesystem services may start after this plugin.
    attachments: () => service<ImageSource>('attachments'),
    imageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments as AttachmentStore,
      hostPath => service<{ processPathFromHostPath(path: string): string | undefined }>('fs')?.processPathFromHostPath(hostPath), ref),
  });
  const registration = ctx.llm.registerAdapter(['siwc'], adapter);
  // A background catalog refresh that changed the list re-notifies the selector.
  adapter.onCatalogUpdated = () => registration?.replace?.(['siwc']);
  ctx.effect(() => () => { adapter.cancelRequests(); auth.abortAll(); });
  // DSH's web_search tool asks ctx.web; the launcher selects this provider ("siwc").
  // A search uses the model of the conversation that asked when it is a ChatGPT-plan model.
  const currentModel = async () => {
    type Initiator = { session?: { requestContext?(): { provider?: string; model?: string } | undefined } };
    const context = service<{ currentInitiator?(): Initiator | undefined }>('agents')?.currentInitiator?.()?.session?.requestContext?.();
    if (context?.provider === 'siwc' && context.model) return context.model;
    return defaultModel(auth, adapter);
  };
  ctx.inject(['web'], webCtx => {
    (webCtx as unknown as { web: { registerSearchProvider(provider: WebSearchProvider): () => void } }).web.registerSearchProvider(new SiwcSearchProvider(adapter, currentModel));
  });
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'siwc', description: 'ChatGPTプラン（Sign in with ChatGPT）の状態・サインイン・モデル一覧・利用状況', recordInput: false,
      input: { hint: 'status | login | models | model <slug> | select <id> | sign-out | manage | resume | diagnostics' },
      handler: async ({ rawInput, signal }) => {
        const [action = 'status', value] = rawInput.trim().split(/\s+/);
        try {
          switch (action) {
            case '': case 'status':
              return { kind: 'success', text: await statusText(auth, adapter, diagnostics) };
            case 'login': case 'continue': {
              adapter.cancelRequests();
              const message = await signIn(auth, { registrationId: value, signal });
              return { kind: 'success', text: `${PRIVACY_NOTICE}\n${message}` };
            }
            case 'confirm': case 'begin':
              return { kind: 'success', text: '確認の手順は不要になりました（サインイン時に一度だけ案内します）。\n' + await statusText(auth, adapter, diagnostics) };
            case 'models': {
              const models = await adapter.listModelsFresh('siwc', signal);
              return { kind: 'success', text: models.length ? models.map(m => `${m.id}: ${m.name}`).join('\n') : 'このアカウントで表示できるモデルがありません。' };
            }
            case 'model':
              if (!value) return { kind: 'error', text: '使い方: /siwc model <slug>（/siwc models で一覧）' };
              await saveModel(auth, value);
              return { kind: 'success', text: `次回の起動時の既定モデルを ${value} にしました。今の会話は入力欄のモデル選択で切り替えられます。` };
            case 'select':
              if (!value) return { kind: 'error', text: '使い方: /siwc select <登録ID>（/siwc status で一覧）' };
              adapter.cancelRequests(); await auth.select(value);
              return { kind: 'success', text: '登録を切り替えました。新しい会話を始めてください。\n' + await statusText(auth, adapter, diagnostics) };
            case 'sign-out': {
              adapter.cancelRequests();
              const result = await auth.signOut(signal);
              return { kind: 'success', text: result.remoteRevocation === 'confirmed' ? 'サインアウトしました（トークンの失効も確認済み）。'
                : `この端末のトークンを削除しました。サーバー側の失効は確認できなかったため、必要ならChatGPTの設定で接続を解除してください。${MANAGE_USAGE}` };
            }
            case 'manage':
              return { kind: 'success', text: `Manage usage: ${MANAGE_USAGE}` };
            case 'resume':
              adapter.resume();
              return { kind: 'success', text: `新しい要求を再開しました。上限が続いている場合は、同じ案内がまた表示されます。${MANAGE_USAGE}` };
            case 'diagnostics': {
              const lines = await diagnostics.tail(20);
              return { kind: 'success', text: [`診断ログ（内容は含みません）: ${diagnostics.location}`, ...(lines.length ? lines : ['まだ記録はありません。'])].join('\n') };
            }
            default:
              return { kind: 'error', text: `使い方: ${HELP}` };
          }
        } catch (error) { return { kind: 'error', text: safeFailure(error) }; }
      },
    });
  });
}
