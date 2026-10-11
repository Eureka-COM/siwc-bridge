import { LlmAdapter, LlmError, IMAGE_OFFLOAD_REQUIRED_CODE, attributionHeaders, contentHasImage, offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload,
  type GenerateOptions, type ImageAttachmentAccess, type LlmModelInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { BridgeError, rememberFailure } from './errors.js';
import { readText } from './http.js';
import { reasoningForModel } from './reasoning.js';
import type { CatalogStore } from './local-cache.js';
import { buildRequest, object, ProviderFailure, providerFailure, readSse, ResponseStream, type RequestImage, type RequestMedia } from './protocol.js';

export interface CredentialSource {
  withAccessToken<T>(operation: (token: string, currentSignal?: AbortSignal, registrationId?: string) => Promise<T>, signal?: AbortSignal): Promise<T>;
  openRequestScope?: (signal?: AbortSignal) => Promise<{ signal: AbortSignal; check?(): Promise<void>; close(): void }>;
  status?: (signal?: AbortSignal) => Promise<{ activeId?: string; registrations?: readonly { id: string; authenticated: boolean; planAllowed: boolean; planConfirmed: boolean }[] }>;
}
/** The part of DSH's attachment service the adapter uses: read one request-sized image version. */
export type ImageSource = Pick<AttachmentStore, 'readImageRequest'>;
export interface AdapterOptions {
  /** Last account catalog (slugs and display names only), shown at once while a background refresh runs. */
  catalogStore?: CatalogStore;
  /** DSH's attachment service, resolved per request; absent means images cannot be sent. */
  attachments?: () => ImageSource | undefined;
  /** Read-only path of an image in the tool environment, named in the text DSH places beside every image. */
  imageAccess?: (attachments: ImageSource, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined;
}
/** Every listed ChatGPT model is offered for text and images; a model that refuses images fails at the service, visibly. */
export const INPUT_MODALITIES = ['text', 'image'] as const;
/** Same request-image policy as DSH's bundled adapters: 2048x2048 pixels, about 1 MiB per image, 20 MiB of base64 per request. */
export const IMAGE_POLICY = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024, maxRequestBase64: 20 * 1024 * 1024 } as const;
/** DSH's own fit-within-pixel-budget rule, keeping the aspect ratio. */
export function requestImageSize(width: number, height: number, maxPixels: number): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.round(w * height / width));
    while (w * h > maxPixels && w > 1) { w -= 1; h = Math.max(1, Math.round(w * height / width)); }
    return { width: w, height: h };
  }
  let h = Math.max(1, Math.floor(height * scale)), w = Math.max(1, Math.round(h * width / height));
  while (w * h > maxPixels && h > 1) { h -= 1; w = Math.max(1, Math.round(h * width / height)); }
  return { width: w, height: h };
}
/** Selector metadata stays valid in memory this long; afterwards it is served while refreshing. */
export const CATALOG_TTL_MS = 10 * 60_000;
export interface RequestObserver {
  beforeRequest?: (kind: 'models' | 'inference', signal: AbortSignal) => Promise<void>;
  afterRequest?: (kind: 'models' | 'inference') => void;
  onUsageLimit?: () => Promise<void>;
  /** Shared stop state; a newer `generation` means a human (re)start in any process. */
  usageState?: () => Promise<{ stopped: boolean; generation: number }>;
}

/** Sanitized native provider labels supplement dsh's stable routing classification. */
export class SiwcLlmError extends LlmError {
  constructor(error: BridgeError, code: string) {
    // dsh persists only failure's standard fields. Retain safe native diagnostics in
    // its message rather than relying on custom Error properties which are lost.
    const labels = [`provider_code=${error.code}`];
    if (error instanceof ProviderFailure) { if (error.param) labels.push(`param=${error.param}`); labels.push(`shape=${error.responseShape}`); }
    // HTTP status and request ID are safe, and needed to diagnose a rejection from the screen.
    if (error.status) labels.push(`http=${error.status}`);
    if (error.requestId) labels.push(`request_id=${error.requestId}`);
    super(`${error.message} [${labels.join(' ')}]`, code, { ...(error.status ? { status: error.status } : {}), ...(error.requestId ? { requestId: error.requestId as never } : {}) });
    rememberFailure(this, `${code}: ${this.message}${error.status ? ` (HTTP ${error.status})` : ''}${error.requestId ? ` [request_id=${error.requestId}]` : ''}`);
    this.providerCode = error.code;
    if (error instanceof ProviderFailure) { this.param = error.param; this.responseShape = error.responseShape; }
  }
  readonly providerCode: string;
  readonly param?: string;
  readonly responseShape?: string;
}

const usageLimit = (error: BridgeError) => ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(error.code);
/** A stop this process already recorded; reported like a quota stop but never recorded again. */
const LOCAL_STOP = 'USAGE_LIMIT_STOPPED';
function responseContext(error: unknown, response?: Response): unknown {
  if (!(error instanceof BridgeError) || !response || error.status !== undefined) return error;
  const requestId = error.requestId ?? providerFailure({}, response.status, response.headers.get('x-request-id')).requestId;
  return error instanceof ProviderFailure
    ? new ProviderFailure(error.code, error.message, response.status, requestId, error.param, error.responseShape)
    : new BridgeError(error.code, error.message, response.status, requestId);
}
function classified(error: unknown, signal?: AbortSignal): LlmError {
  if (signal?.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') return new SiwcLlmError(new BridgeError('TIMEOUT', 'SIWC要求が制限時間内に完了しませんでした。'), 'TIMEOUT');
  if (signal?.aborted || (error instanceof BridgeError && ['CANCELLED', 'cancelled'].includes(error.code))) return new SiwcLlmError(new BridgeError('CANCELLED', 'SIWC要求を中断しました。'), 'ABORTED');
  if (error instanceof SiwcLlmError) return error;
  // DSH's own image-offload request carries its retry instruction; pass it through unchanged.
  if (error instanceof LlmError && error.code === IMAGE_OFFLOAD_REQUIRED_CODE) return error;
  if (!(error instanceof BridgeError)) return new SiwcLlmError(new BridgeError('TRANSPORT', 'SIWC通信または応答処理に失敗しました。要求の自動再実行はしません。'), 'TRANSPORT');
  const code = usageLimit(error) || error.code === LOCAL_STOP ? 'QUOTA'
    : error.code === 'insufficient_quota' ? 'ACCOUNT_QUOTA'
    : error.code === 'UNSUPPORTED_CONTENT' || error.code === 'UNSUPPORTED_TOOL' || error.code === 'UNSUPPORTED_OPTION' ? 'UNSUPPORTED_OPTION'
    : error.status === 401 ? 'AUTH'
    : error.status === 403 ? 'FORBIDDEN'
    : error.status === 429 ? 'RATE_LIMIT'
    : error.status !== undefined && error.status >= 500 ? 'SERVER'
    : error.code;
  return new SiwcLlmError(error, code);
}

export class SiwcAdapter extends LlmAdapter {
  /** Shared start generation seen when this process stopped; Infinity if it could not be read. */
  private limitedAt?: number;
  private readonly requests = new Set<AbortController>();
  private catalog?: { provider: string; registrationId: string; expiresAt: number; models: readonly LlmModelInfo[] };
  private catalogGeneration = 0;
  private backgroundRefresh?: Promise<void>;
  /** Called after a background refresh changes the catalog, so the GUI re-lists it. */
  onCatalogUpdated?: () => void;
  constructor(private readonly credentials: CredentialSource, private readonly observer: RequestObserver = {}, private readonly options: AdapterOptions = {}) { super(); }
  override providerInfo(provider: string) { return { id: provider, name: 'ChatGPT plan (SIWC)' }; }
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return { mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT', 'SERVER'], initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 };
  }
  resetUsageLimit(): void { this.limitedAt = undefined; }
  isUsageLimited(): boolean { return this.limitedAt !== undefined; }
  /** Current stop after picking up a human start recorded by any process. */
  async usageLimited(): Promise<boolean> { try { await this.checkUsageStop(); return false; } catch { return true; } }
  cancelRequests(): void { this.discardCatalog(); for (const controller of this.requests) controller.abort(); }
  private discardCatalog(): void { this.catalog = undefined; this.catalogGeneration++; }
  private async stopForUsage(error: unknown): Promise<void> {
    if (error instanceof BridgeError && usageLimit(error)) {
      this.limitedAt = Number.POSITIVE_INFINITY;
      await this.observer.onUsageLimit?.();
      // Only a start recorded after this point may lift the stop in this process.
      const state = await this.observer.usageState?.().catch(() => undefined);
      if (state && Number.isSafeInteger(state.generation)) this.limitedAt = state.generation;
    }
  }
  /** Refuse while stopped, unless any process (DSH screen or CLI) has recorded a newer human start. */
  private async checkUsageStop(): Promise<void> {
    if (this.limitedAt === undefined) return;
    const state = await this.observer.usageState?.().catch(() => undefined);
    if (state && !state.stopped && Number.isSafeInteger(state.generation) && state.generation > this.limitedAt) { this.limitedAt = undefined; return; }
    throw new BridgeError(LOCAL_STOP, 'ChatGPTプラン利用が停止中です。公式Usageを確認してから /siwc resume confirmed で再開してください。');
  }

  private async identity(signal: AbortSignal): Promise<string | undefined> {
    return this.credentials.status ? (await this.credentials.status(signal)).activeId : undefined;
  }
  private async request(kind: 'models' | 'inference', signal: AbortSignal, body?: Record<string, unknown>, expectedIdentity?: string, tokenIdentity?: (registrationId?: string) => void): Promise<Response> {
    signal.throwIfAborted();
    const identity = kind === 'inference' ? await this.identity(signal) : undefined;
    if (expectedIdentity !== undefined && expectedIdentity !== identity) throw new BridgeError('INVALID_REPLAY_CONTEXT', '選択登録が変わりました。新しい会話を開始してください。');
    return this.credentials.withAccessToken(async (token, currentSignal, registrationId) => {
      const requestSignal = currentSignal ? AbortSignal.any([signal, currentSignal]) : signal;
      requestSignal.throwIfAborted();
      // Production auth supplies the ID bound to this token while holding its store lock.
      if (expectedIdentity !== undefined && expectedIdentity !== registrationId) throw new BridgeError('INVALID_REPLAY_CONTEXT', '送信時の登録と会話履歴が一致しないか、登録を確認できません。新しい会話を開始してください。');
      tokenIdentity?.(registrationId);
      if (kind === 'inference') await this.checkUsageStop();
      const headers = new Headers(attributionHeaders());
      // Attribution can never replace the bearer or add a tenant/billing path.
      headers.delete('openai-organization'); headers.delete('openai-project');
      headers.set('authorization', `Bearer ${token}`);
      headers.set('accept', kind === 'models' ? 'application/json' : 'text/event-stream');
      if (kind === 'inference') headers.set('content-type', 'application/json');
      await this.observer.beforeRequest?.(kind, requestSignal);
      requestSignal.throwIfAborted();
      try {
        const response = await fetch(kind === 'models' ? 'https://api.openai.com/v1/models' : 'https://api.openai.com/v1/responses', {
          method: kind === 'models' ? 'GET' : 'POST', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: requestSignal, redirect: 'error',
        });
        if (!response.ok) {
          let value: unknown;
          try { value = JSON.parse(await readText(response, requestSignal)); }
          catch (error) { if (error instanceof BridgeError) throw responseContext(error, response); value = undefined; }
          throw providerFailure(value, response.status, response.headers.get('x-request-id'));
        }
        return response;
      } finally { this.observer.afterRequest?.(kind); }
    }, signal);
  }

  /** Registration whose credentials are currently usable, or undefined. Never cached. */
  private async authorizedRegistration(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.credentials.status) return undefined;
    const status = await this.credentials.status(signal);
    const row = status.activeId ? status.registrations?.find(candidate => candidate.id === status.activeId) : undefined;
    return row?.authenticated && row.planAllowed && row.planConfirmed ? row.id : undefined;
  }

  /** Cached, then saved (refreshing in the background), then a fresh account GET. */
  override async listModels(provider: string, callerSignal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const generation = this.catalogGeneration;
    const snapshot = this.catalog;
    if (snapshot?.provider === provider && this.credentials.status) {
      let registrationId: string | undefined;
      try { registrationId = await this.authorizedRegistration(callerSignal); }
      catch (error) { throw classified(error, callerSignal); }
      const current = this.catalog;
      if (current && current === snapshot && generation === this.catalogGeneration && registrationId === current.registrationId) {
        if (current.expiresAt <= Date.now()) this.refreshInBackground(provider);
        return structuredClone(current.models);
      }
    }
    if (this.options.catalogStore && this.credentials.status) {
      let registrationId: string | undefined;
      try { registrationId = await this.authorizedRegistration(callerSignal); }
      catch (error) { throw classified(error, callerSignal); }
      const stored = registrationId ? await this.options.catalogStore.load(registrationId).catch(() => undefined) : undefined;
      if (registrationId && stored?.length && generation === this.catalogGeneration) {
        const models: LlmModelInfo[] = stored.map(model => ({ provider, id: model.id, name: model.name, inputModalities: [...INPUT_MODALITIES] }));
        this.catalog = { provider, registrationId, expiresAt: Date.now() + CATALOG_TTL_MS, models: structuredClone(models) };
        this.refreshInBackground(provider);
        return models;
      }
    }
    return this.listModelsFresh(provider, callerSignal);
  }

  private refreshInBackground(provider: string): void {
    if (this.backgroundRefresh) return;
    const before = JSON.stringify(this.catalog?.models.map(model => [model.id, model.name]) ?? []);
    this.backgroundRefresh = this.listModelsFresh(provider, undefined, true).then(models => {
      if (JSON.stringify(models.map(model => [model.id, model.name])) !== before) this.onCatalogUpdated?.();
    }, () => undefined).finally(() => { this.backgroundRefresh = undefined; });
  }

  /** Explicit refresh: always a fresh account request. A background refresh keeps the current snapshot on failure. */
  async listModelsFresh(provider: string, callerSignal?: AbortSignal, keepCurrent = false): Promise<readonly LlmModelInfo[]> {
    if (!keepCurrent) this.catalog = undefined;
    const generation = this.catalogGeneration;
    let registrationId: string | undefined;
    const controller = new AbortController(); this.requests.add(controller);
    const signals = [controller.signal, AbortSignal.timeout(60_000)]; if (callerSignal) signals.push(callerSignal);
    let signal = AbortSignal.any(signals);
    let scope: { signal: AbortSignal; check?(): Promise<void>; close(): void } | undefined;
    let response: Response | undefined;
    try {
      scope = await this.credentials.openRequestScope?.(signal);
      if (scope) signal = AbortSignal.any([signal, scope.signal]);
      await scope?.check?.();
      response = await this.request('models', signal, undefined, undefined, id => { registrationId = id; });
      const value: unknown = JSON.parse(await readText(response, signal));
      await scope?.check?.();
      signal.throwIfAborted();
      if (!object(value) || !Array.isArray(value.models)) throw new BridgeError('INVALID_MODEL_CATALOG', 'アカウント別モデル一覧の形式が不正です。');
      const models: LlmModelInfo[] = []; const slugs = new Set<string>();
      for (const raw of value.models) {
        if (!object(raw) || raw.visibility !== 'list') continue;
        if (typeof raw.slug !== 'string' || !raw.slug.trim() || raw.slug.length > 200 || typeof raw.display_name !== 'string'
          || !raw.display_name.trim() || raw.display_name.length > 200 || slugs.has(raw.slug)) throw new BridgeError('INVALID_MODEL_CATALOG', '表示対象モデルのslugまたは表示名が不正です。');
        slugs.add(raw.slug); models.push({ provider, id: raw.slug, name: raw.display_name, inputModalities: [...INPUT_MODALITIES] });
      }
      if (this.credentials.status && registrationId && generation === this.catalogGeneration) {
        this.catalog = { provider, registrationId, expiresAt: Date.now() + CATALOG_TTL_MS, models: structuredClone(models) };
        await this.options.catalogStore?.save(registrationId, models.map(model => ({ id: model.id, name: model.name ?? model.id }))).catch(() => undefined);
      }
      return models;
    } catch (error) {
      if (!keepCurrent) this.discardCatalog();
      await this.stopForUsage(error); throw classified(responseContext(error, response), signal);
    }
    finally { scope?.close(); this.requests.delete(controller); await response?.body?.cancel().catch(() => undefined); }
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const models = await this.listModels(provider, signal);
    const selected = models.find(candidate => candidate.id === model);
    if (!selected) throw new SiwcLlmError(new BridgeError('MODEL_NOT_AVAILABLE', '選択したアカウントの表示対象モデルから選択してください。'), 'MODEL_NOT_AVAILABLE');
    // Context and generation caps are not disclosed by the documented catalog. Effort
    // choices come from documented exact model IDs; unspecified effort stays the provider default.
    const reasoning = reasoningForModel(model);
    return { ...selected, systemPromptUpdate: 'in-history', ...(reasoning ? { reasoning } : {}) };
  }

  /**
   * Read request versions of attached images through DSH's attachment service.
   * Offloaded images become DSH's placeholder text; when the request would carry
   * too many image bytes, DSH is asked to offload the oldest ones and retry.
   */
  private async prepareMedia(options: GenerateOptions, signal: AbortSignal): Promise<{ options: GenerateOptions; media?: RequestMedia }> {
    if (!options.messages.some(message => contentHasImage(message.content))) return { options };
    const attachments = this.options.attachments?.();
    if (!attachments) throw new BridgeError('UNSUPPORTED_CONTENT', '画像を読み込めませんでした。DSHの添付機能が有効か確認してください。');
    const access = (ref: ImageAttachmentRef) => this.options.imageAccess?.(attachments, ref);
    const messages = projectOffloadedImages(options.messages, ref => offloadedImageText(ref, access(ref)));
    const refs = new Map<string, ImageAttachmentRef>();
    for (const message of messages) for (const block of message.content) if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment);
    const images = new Map<string, RequestImage & { bytes: number }>();
    for (const ref of refs.values()) {
      signal.throwIfAborted();
      const size = requestImageSize(ref.width, ref.height, IMAGE_POLICY.maxPixels);
      const version = await attachments.readImageRequest(ref, { ...size, maxBytes: IMAGE_POLICY.maxBytes }, signal);
      images.set(ref.attachmentId, { data: version.data, mediaType: version.mediaType, width: version.width, height: version.height, bytes: version.bytes });
    }
    const offloadImages = requiredImageOffload(messages, { representation: 'base64', maxBytes: IMAGE_POLICY.maxRequestBase64 }, block => images.get(block.attachment.attachmentId)?.bytes ?? 0);
    if (offloadImages > 0) throw new LlmError(`添付画像の合計が大きすぎるため、古い画像${offloadImages}枚をテキスト参照に置き換えて再実行します。`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
    return {
      options: messages === options.messages ? options : { ...options, messages: [...messages] },
      media: { images, handle: (ref, version) => requestImageHandleText(ref, version, access(ref)) },
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const controller = new AbortController(); this.requests.add(controller);
    const signals = [controller.signal, AbortSignal.timeout(180_000)]; if (options.signal) signals.push(options.signal);
    let signal = AbortSignal.any(signals);
    let scope: { signal: AbortSignal; check?(): Promise<void>; close(): void } | undefined;
    let response: Response | undefined;
    try {
      scope = await this.credentials.openRequestScope?.(signal);
      if (scope) signal = AbortSignal.any([signal, scope.signal]);
      const identity = await this.identity(signal);
      if (identity === undefined && options.messages.some(message => message.role === 'assistant' && message.source.replayState !== undefined)) {
        throw new BridgeError('INVALID_REPLAY_CONTEXT', '内部履歴の元登録を確認できません。登録情報を提供する認証元で新しい会話を開始してください。');
      }
      const prepared = await this.prepareMedia(options, signal);
      const body = buildRequest(prepared.options, identity, prepared.media);
      await this.checkUsageStop();
      // No catalog GET here: the catalog is not an entitlement check, and a completed
      // inference is what verifies model access. An unavailable model fails at the service.
      await scope?.check?.();
      response = await this.request('inference', signal, body, identity);
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!response.body || (type && type !== 'text/event-stream')) throw new BridgeError('INVALID_STREAM', 'SIWCのstream応答を確認できません。');
      const stream = new ResponseStream(options.model, new Set(options.tools?.map(tool => tool.name) ?? []), identity);
      for await (const event of readSse(response.body, signal)) {
        signal.throwIfAborted();
        const chunks = stream.accept(event);
        if (chunks.some(chunk => chunk.type === 'finish') && await this.identity(signal) !== identity) throw new BridgeError('INVALID_REPLAY_CONTEXT', '完了前に登録が変わりました。新しい会話を開始してください。');
        for (const chunk of chunks) {
          await scope?.check?.(); signal.throwIfAborted();
          signal.throwIfAborted(); yield chunk;
        }
        if (stream.completed) break;
      }
      stream.end();
    } catch (error) {
      await this.stopForUsage(error);
      throw classified(responseContext(error, response), signal);
    } finally {
      controller.abort(); scope?.close(); this.requests.delete(controller);
      await response?.body?.cancel().catch(() => undefined);
    }
  }
}
