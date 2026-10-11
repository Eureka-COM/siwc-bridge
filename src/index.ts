import { AuthManager } from './auth.js';
import { RequestBudget, type BeginOptions } from './budget.js';
import { SiwcClient } from './client.js';
import { validateAppIdentity, type AppIdentity } from './app.js';

export { AuthManager } from './auth.js';
export type { AuthStatus, LoginOptions } from './auth.js';
export { RequestBudget } from './budget.js';
export type { BeginOptions, BudgetStatus } from './budget.js';
export { SiwcClient } from './client.js';
export type { CredentialSource, RequestObserver, ReplayOptions, UsageState } from './client.js';
export type { AppIdentity } from './app.js';
export type { InputMessage, OutputMessage, ReasoningItem, FunctionCallItem, FunctionCallOutputItem,
  ResponseInputItem, ResponseOutputItem, FunctionTool, NamespaceTool, ResponseRequest, ModelInfo,
  TokenUsage, CompletedResponse, ClientEvent } from './types.js';
export { BridgeError, safeFailure } from './errors.js';
export { ProviderFailure } from './protocol.js';

export const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';
export const PRIVACY_NOTICE = 'この接続アプリは本人のChatGPTアカウントと許可されたChatGPTプランを使用します。プロンプト・必要な会話履歴・ツール定義・ツール結果をOpenAIへ送信し、認証情報はこのWindowsユーザーのアプリ専用DPAPI保存領域に保存します。既存Codexやブラウザの認証情報は取り込みません。ローカルツールの実行と権限は接続アプリが管理します。Continue with ChatGPTで本人がログインと利用同意を行ってください。';

export function createWindowsClient(options: AppIdentity) {
  const app = validateAppIdentity(options);
  const budget = new RequestBudget(app.appId);
  const auth = new AuthManager({ ...app, onRequest: (kind, signal) => budget.request(kind, signal) });
  const client = new SiwcClient(auth, {
    beforeRequest: (kind, signal) => budget.request(kind, signal),
    onUsageLimit: () => budget.stop(),
    usageState: async () => { const state = await budget.status(); return { stopped: !state.enabled, generation: state.generation ?? 0 }; },
  });
  return {
    auth, client, budget,
    async begin(options: BeginOptions) { const state = await budget.begin(options); client.resetUsageLimit(); return state; },
    async stop() { client.cancelRequests(); await budget.stop(); },
  };
}
