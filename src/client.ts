import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from './errors.js';
import { readText } from './http.js';
import { buildRequest, object, ProviderFailure, providerFailure, readSse, ResponseStream } from './protocol.js';
import type { ClientEvent, CompletedResponse, ModelInfo, ResponseRequest, ResponseOutputItem } from './types.js';

export interface CredentialSource {
  withAccessToken<T>(operation: (token: string, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  openRequestScope?: (signal?: AbortSignal) => Promise<{ signal: AbortSignal; check?(): Promise<void>; close(): void }>;
  status?: (signal?: AbortSignal) => Promise<{ activeId?: string }>;
}
export interface RequestObserver {
  beforeRequest: (kind: 'models' | 'inference', signal: AbortSignal) => Promise<void>;
  /** Persist the stop in the host's shared policy; only a new human start may clear it. */
  onUsageLimit?: () => Promise<void>;
}
export interface ReplayOptions { maxReplayItems?: number }
const usageLimit = (error: BridgeError) => ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(error.code);
const digest = (item: Record<string, unknown>) => createHash('sha256').update(JSON.stringify(item)).digest('hex');
function failure(error: unknown, response?: Response, signal?: AbortSignal): BridgeError {
  if (signal?.aborted) return new BridgeError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', 'SIWC要求を中断しました。');
  if (!(error instanceof BridgeError)) return new BridgeError('TRANSPORT', 'SIWC通信または応答処理に失敗しました。要求を自動再実行しません。');
  if (!response || error.status !== undefined) return error;
  const requestId = error.requestId ?? providerFailure({}, response.status, response.headers.get('x-request-id')).requestId;
  return error instanceof ProviderFailure
    ? new ProviderFailure(error.code, error.message, response.status, requestId, error.param, error.responseShape)
    : new BridgeError(error.code, error.message, response.status, requestId);
}

/** One HTTP turn only. The connected application owns tools, permissions and its agent loop. */
export class SiwcClient {
  private readonly requests = new Set<AbortController>();
  private readonly replays = new Map<string, { model: string; identity: string }>();
  private readonly instanceIdentity = randomUUID();
  private readonly maxReplayItems: number;
  private replayIdentity?: string;
  private replayEpoch = 0;
  private limited = false;
  constructor(private readonly credentials: CredentialSource, private readonly observer: RequestObserver, options: ReplayOptions = {}) {
    this.maxReplayItems = options.maxReplayItems ?? 4096;
    if (!Number.isSafeInteger(this.maxReplayItems) || this.maxReplayItems < 1 || this.maxReplayItems > 65536) {
      throw new BridgeError('INVALID_REPLAY_LIMIT', '履歴保持上限は1〜65536の整数で指定してください。');
    }
  }
  cancelRequests(): void { for (const request of this.requests) request.abort(); }
  /** End conversations and invalidate in-flight provenance before releasing the host's history. */
  clearReplayHistory(): void { this.cancelRequests(); this.replays.clear(); this.replayEpoch++; }
  isUsageLimited(): boolean { return this.limited; }
  resetUsageLimit(): void { this.limited = false; }
  private async stopForUsage(error: unknown): Promise<void> {
    if (error instanceof BridgeError && usageLimit(error)) {
      this.limited = true;
      await this.observer.onUsageLimit?.();
    }
  }
  private async identity(signal: AbortSignal): Promise<string> {
    return this.credentials.status ? (await this.credentials.status(signal)).activeId ?? 'not-signed-in' : this.instanceIdentity;
  }
  private async request(kind: 'models' | 'inference', signal: AbortSignal, body?: Record<string, unknown>): Promise<Response> {
    signal.throwIfAborted();
    return this.credentials.withAccessToken(async (token, currentSignal) => {
      const combined = currentSignal ? AbortSignal.any([signal, currentSignal]) : signal;
      combined.throwIfAborted();
      if (kind === 'inference' && this.limited) throw new BridgeError('subscription_sharing_usage_limit_exceeded', '公式Usageを本人が確認するまで推論を停止します。');
      const headers = new Headers({ authorization: `Bearer ${token}`, accept: kind === 'models' ? 'application/json' : 'text/event-stream',
        'user-agent': 'siwc-bridge/0.2.1 (https://github.com/Eureka-COM/siwc-bridge)' });
      if (body) headers.set('content-type', 'application/json');
      await this.observer.beforeRequest(kind, combined);
      combined.throwIfAborted();
      const response = await fetch(kind === 'models' ? 'https://api.openai.com/v1/models' : 'https://api.openai.com/v1/responses', {
        method: kind === 'models' ? 'GET' : 'POST', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: combined, redirect: 'error',
      });
      if (!response.ok) {
        let value: unknown;
        try { value = JSON.parse(await readText(response, combined)); }
        catch (error) { if (error instanceof BridgeError) throw failure(error, response, combined); value = undefined; }
        throw providerFailure(value, response.status, response.headers.get('x-request-id'));
      }
      return response;
    }, signal);
  }
  async listModels(callerSignal?: AbortSignal): Promise<ModelInfo[]> {
    const controller = new AbortController(); this.requests.add(controller);
    let signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000), ...(callerSignal ? [callerSignal] : [])]);
    let scope: Awaited<ReturnType<NonNullable<CredentialSource['openRequestScope']>>> | undefined;
    let response: Response | undefined;
    try {
      scope = await this.credentials.openRequestScope?.(signal);
      if (scope) signal = AbortSignal.any([signal, scope.signal]);
      await scope?.check?.(); response = await this.request('models', signal);
      const value: unknown = JSON.parse(await readText(response, signal));
      await scope?.check?.(); signal.throwIfAborted();
      if (!object(value) || !Array.isArray(value.models)) throw new BridgeError('INVALID_MODEL_CATALOG', 'アカウント別モデル一覧の形式が不正です。');
      const slugs = new Set<string>(); const models: ModelInfo[] = [];
      for (const row of value.models) {
        if (!object(row) || row.visibility !== 'list') continue;
        if (typeof row.slug !== 'string' || !row.slug.trim() || row.slug.length > 200 || slugs.has(row.slug)
          || typeof row.display_name !== 'string' || !row.display_name.trim() || row.display_name.length > 200) throw new BridgeError('INVALID_MODEL_CATALOG', '表示対象モデルが不正です。');
        slugs.add(row.slug); models.push({ id: row.slug, name: row.display_name });
      }
      return models;
    } catch (error) { await this.stopForUsage(error); throw failure(error, response, signal); }
    finally { scope?.close(); this.requests.delete(controller); await response?.body?.cancel().catch(() => undefined); }
  }
  private replayKey(model: string, item: Record<string, unknown>): string { return `${model}\0${digest(item)}`; }
  private validateReplay(options: Pick<ResponseRequest, 'input' | 'model'>, identity: string): Map<string, { model: string; identity: string }> {
    const retained = new Map<string, { model: string; identity: string }>();
    for (const item of options.input) {
      if (!object(item) || (item.type !== 'reasoning' && !(typeof item.id === 'string' && ['message', 'function_call'].includes(String(item.type))))) continue;
      const key = this.replayKey(options.model, item), saved = this.replays.get(key);
      if (!saved || saved.model !== options.model || saved.identity !== identity) throw new BridgeError('INVALID_REPLAY_CONTEXT', 'ネイティブ履歴は同じクライアント・モデル・選択登録の完了応答だけ再利用できます。');
      retained.set(key, saved);
    }
    return retained;
  }
  private retainReplay(model: string, identity: string, epoch: number, retained: Map<string, { model: string; identity: string }>, output: ResponseOutputItem[]): void {
    if (epoch !== this.replayEpoch || identity !== this.replayIdentity) throw new BridgeError('INVALID_REPLAY_CONTEXT', '履歴を破棄または登録を変更した要求の完了履歴は再利用できません。');
    for (const item of output) retained.set(this.replayKey(model, item as ResponseOutputItem & Record<string, unknown>), { model, identity });
    if (retained.size > this.maxReplayItems) throw new BridgeError('REPLAY_CAPACITY_EXCEEDED', '現在のネイティブ履歴と完了項目が保持上限を超えました。履歴を削減するか、明示的に会話を終了してください。');
    // Keep the complete current conversation; only older unrelated provenance may be evicted.
    for (const key of retained.keys()) this.replays.delete(key);
    while (this.replays.size + retained.size > this.maxReplayItems) this.replays.delete(this.replays.keys().next().value!);
    for (const [key, saved] of retained) this.replays.set(key, saved);
  }
  async *stream(options: ResponseRequest): AsyncGenerator<ClientEvent> {
    const controller = new AbortController(); this.requests.add(controller);
    let signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000), ...(options.signal ? [options.signal] : [])]);
    let scope: Awaited<ReturnType<NonNullable<CredentialSource['openRequestScope']>>> | undefined;
    let response: Response | undefined;
    try {
      const body = buildRequest(options);
      const model = body.model as string, input = body.input as ResponseRequest['input'];
      scope = await this.credentials.openRequestScope?.(signal);
      if (scope) signal = AbortSignal.any([signal, scope.signal]);
      await scope?.check?.();
      const identity = await this.identity(signal);
      if (this.replayIdentity !== identity) { this.replays.clear(); this.replayEpoch++; this.replayIdentity = identity; }
      const epoch = this.replayEpoch, retained = this.validateReplay({ model, input }, identity);
      if (this.limited) throw new BridgeError('subscription_sharing_usage_limit_exceeded', '公式Usageを本人が確認するまで推論を停止します。');
      // No catalog GET before inference: SIWC documents the catalog as selector data,
      // not an entitlement check; a completed turn is what verifies model access.
      await scope?.check?.();
      response = await this.request('inference', signal, body);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!response.body || (contentType && contentType !== 'text/event-stream')) throw new BridgeError('INVALID_STREAM', 'SIWCのstream応答を確認できません。');
      const allowed = new Set(options.tools?.flatMap(namespace => namespace.tools.map(tool => `${namespace.name}/${tool.name}`)) ?? []);
      const stream = new ResponseStream(model, allowed);
      for await (const event of readSse(response.body, signal)) {
        signal.throwIfAborted();
        for (const chunk of stream.accept(event)) {
          await scope?.check?.(); signal.throwIfAborted();
          if (chunk.type === 'completed') {
            if (await this.identity(signal) !== identity) throw new BridgeError('INVALID_REPLAY_CONTEXT', '完了前に選択登録が変わった要求の履歴は保持しません。');
            signal.throwIfAborted(); this.retainReplay(model, identity, epoch, retained, chunk.response.output);
          }
          yield chunk;
        }
        if (stream.completed) break;
      }
      stream.end();
    } catch (error) {
      await this.stopForUsage(error);
      throw failure(error, response, signal);
    } finally {
      controller.abort(); scope?.close(); this.requests.delete(controller);
      await response?.body?.cancel().catch(() => undefined);
    }
  }
  async complete(options: ResponseRequest): Promise<CompletedResponse> {
    let result: CompletedResponse | undefined;
    for await (const event of this.stream(options)) if (event.type === 'completed') result = event.response;
    if (!result) throw new BridgeError('STREAM_INTERRUPTED', '正常な完了応答がありません。');
    return result;
  }
}
