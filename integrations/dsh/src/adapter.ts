import { LlmAdapter, LlmError, IMAGE_OFFLOAD_REQUIRED_CODE, attributionHeaders, contentHasImage, isContextWindowExceededError, offloadedImageText, projectOffloadedImages,
  requestImageHandleText, requiredImageOffload, resolveRetryPolicy,
  type GenerateOptions, type ImageAttachmentAccess, type LlmModelInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { BridgeError, rememberFailure } from './errors.js';
import { readText } from './http.js';
import { contextForModel, reasoningForModel, searchEffort } from './reasoning.js';
import type { CatalogStore } from './local-cache.js';
import { noDiagnostics, type Diagnostics } from './diagnostics.js';
import { buildRequest, label, Notes, object, ProviderFailure, providerFailure, readSse, ResponseStream, type RequestDocument, type RequestImage, type RequestMedia } from './protocol.js';
import { checkedQuery, SEARCH_TIMEOUT_MS, SearchCollector, searchRequest, type WebSearchRequest, type WebSearchResult } from './web-search.js';
import { documentFileName, documentKey, MAX_PDF_BYTES, MAX_REQUEST_DOCUMENT_BASE64, parseDocuments, PDF_TOOL } from './documents.js';

export interface CredentialSource {
  withAccessToken<T>(operation: (token: string, currentSignal?: AbortSignal, registrationId?: string) => Promise<T>, signal?: AbortSignal): Promise<T>;
  openRequestScope?: (signal?: AbortSignal) => Promise<{ signal: AbortSignal; check?(): Promise<void>; close(): void }>;
  status?: (signal?: AbortSignal) => Promise<{ activeId?: string; registrations?: readonly { id: string; authenticated: boolean; planAllowed: boolean; planConfirmed: boolean }[] }>;
}
/** The parts of DSH's attachment service the adapter uses: request-sized images, and stored files for read_pdf. */
export type ImageSource = Pick<AttachmentStore, 'readImageRequest'> & Partial<Pick<AttachmentStore, 'readFileStream'>>;
export interface AdapterOptions {
  /** Last account catalog (slugs and display names only), shown at once while a background refresh runs. */
  catalogStore?: CatalogStore;
  /** DSH's attachment service, resolved per request; absent means images are described as text. */
  attachments?: () => ImageSource | undefined;
  /** Read-only path of an image in the tool environment, named in the text DSH places beside every image. */
  imageAccess?: (attachments: ImageSource, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined;
  /** Local machine-label log of each request. */
  diagnostics?: Diagnostics;
  /** Longest silence while a response streams before the attempt is abandoned (retryable). */
  idleTimeoutMs?: number;
}
/** Selector metadata stays valid in memory this long; afterwards it is served while refreshing. */
export const CATALOG_TTL_MS = 10 * 60_000;
/** Every listed ChatGPT model is offered for text and images; a model that refuses images fails at the service, visibly. */
export const INPUT_MODALITIES = ['text', 'image'] as const;
/** Same request-image policy as DSH's bundled adapters: 2048x2048 pixels, about 1 MiB per image, 20 MiB of base64 per request. */
export const IMAGE_POLICY = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024, maxRequestBase64: 20 * 1024 * 1024 } as const;
const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';

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

/** DSH failure carrying safe native labels (provider code, HTTP status, request ID) in its message. */
export class SiwcLlmError extends LlmError {
  constructor(error: BridgeError, code: string) {
    const labels = [`provider_code=${error.code}`];
    if (error instanceof ProviderFailure && error.param) labels.push(`param=${error.param}`);
    if (error.status) labels.push(`http=${error.status}`);
    if (error.requestId) labels.push(`request_id=${error.requestId}`);
    super(`${error.message} [${labels.join(' ')}]`, code, { ...(error.status ? { status: error.status } : {}), ...(error.requestId ? { requestId: error.requestId as never } : {}) });
    rememberFailure(this, `${code}: ${this.message}`);
    this.providerCode = error.code;
    if (error instanceof ProviderFailure) this.param = error.param;
  }
  readonly providerCode: string;
  readonly param?: string;
}

const USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded';
const SIGN_IN = new Set(['sign_in_required', 'plan_permission_required', 'plan_confirmation_required', 'unauthorized', 'subscription_sharing_invalid_user', 'id_token_invalid']);
const RETRYABLE_SERVICE = new Set(['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable', 'service_unavailable', 'server_error']);

/** Map any failure to DSH's routing codes; retry decisions follow DSH's own policy for these codes. */
export function classify(error: unknown, signal?: AbortSignal): LlmError {
  if (error instanceof LlmError) return error;
  if (signal?.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
    return new SiwcLlmError(new BridgeError('TIMEOUT', 'ChatGPTの応答が止まったため、この試行を打ち切りました。'), 'TIMEOUT');
  }
  if (signal?.aborted) return new SiwcLlmError(new BridgeError('CANCELLED', '中断しました。'), 'ABORTED');
  if (!(error instanceof BridgeError)) return new SiwcLlmError(new BridgeError('TRANSPORT', 'ChatGPTとの通信に失敗しました。'), 'TRANSPORT');
  const status = error.status;
  const code = error.code === USAGE_LIMIT || error.code === 'USAGE_PAUSED' ? 'QUOTA'
    : error.code === 'CANCELLED' || error.code === 'cancelled' ? 'ABORTED'
    : error.code === 'EMPTY_RESPONSE' ? 'EMPTY_RESPONSE'
    : error.code === 'TIMEOUT' ? 'TIMEOUT'
    : error.code === 'context_length_exceeded' || isContextWindowExceededError(error.code) ? 'CONTEXT_WINDOW_EXCEEDED'
    : error.code === 'subscription_sharing_unsupported_capability' ? 'UNSUPPORTED_OPTION'
    : ['STREAM_INTERRUPTED', 'TRANSPORT', 'RESPONSE_INCOMPLETE'].includes(error.code) ? 'TRANSPORT'
    : RETRYABLE_SERVICE.has(error.code) || (status !== undefined && status >= 500) ? 'SERVER'
    : status === 429 ? 'RATE_LIMIT'
    : SIGN_IN.has(error.code) || status === 401 ? 'AUTH'
    : status === 403 ? 'FORBIDDEN'
    : error.code;
  return new SiwcLlmError(error, code);
}

/** A 400 that names a file or URL input: the service could not use an attached PDF. */
function documentRejected(error: unknown): boolean {
  return error instanceof ProviderFailure && error.status === 400
    && (/url|file|document|pdf/i.test(error.param ?? '') || /file|pdf|document/i.test(error.code));
}

export class SiwcAdapter extends LlmAdapter {
  private paused = false;
  /** PDFs the service refused in this process; later requests send a note instead. */
  private readonly failedDocuments = new Set<string>();
  private readonly requests = new Set<AbortController>();
  private catalog?: { provider: string; registrationId: string; expiresAt: number; models: readonly LlmModelInfo[] };
  private catalogGeneration = 0;
  private backgroundRefresh?: Promise<void>;
  private readonly retry: ResolvedRetryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 4, backoff: { initialDelayMs: 1000, maxDelayMs: 15_000, jitterRatio: 0.2 } }, 'siwc');
  /** Called after a background refresh changes the catalog, so the GUI re-lists it. */
  onCatalogUpdated?: () => void;
  constructor(private readonly credentials: CredentialSource, private readonly options: AdapterOptions = {}) { super(); }
  private get diagnostics(): Diagnostics { return this.options.diagnostics ?? noDiagnostics; }
  override providerInfo(provider: string) { return { id: provider, name: 'ChatGPT plan (SIWC)' }; }
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy { return this.retry; }

  /** After a usage-limit error, new requests wait until the user resumes (SIWC guidance: pause and point to Usage). */
  isPaused(): boolean { return this.paused; }
  resume(): void { this.paused = false; }
  cancelRequests(): void { this.discardCatalog(); for (const controller of this.requests) controller.abort(); }
  private discardCatalog(): void { this.catalog = undefined; this.catalogGeneration++; }

  private async request(kind: 'models' | 'inference', signal: AbortSignal, body: (registrationId?: string) => Record<string, unknown> | undefined,
    tokenIdentity?: (registrationId?: string) => void): Promise<Response> {
    signal.throwIfAborted();
    return this.credentials.withAccessToken(async (token, currentSignal, registrationId) => {
      const requestSignal = currentSignal ? AbortSignal.any([signal, currentSignal]) : signal;
      requestSignal.throwIfAborted();
      tokenIdentity?.(registrationId);
      // The body is built for the registration the token belongs to, so reused history always matches the sending account.
      const payload = body(registrationId);
      const headers = new Headers(attributionHeaders());
      headers.delete('openai-organization'); headers.delete('openai-project');
      headers.set('authorization', `Bearer ${token}`);
      headers.set('accept', kind === 'models' ? 'application/json' : 'text/event-stream');
      if (payload) headers.set('content-type', 'application/json');
      const response = await fetch(kind === 'models' ? 'https://api.openai.com/v1/models' : 'https://api.openai.com/v1/responses', {
        method: kind === 'models' ? 'GET' : 'POST', headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: requestSignal, redirect: 'error',
      });
      if (!response.ok) {
        let value: unknown;
        try { value = JSON.parse(await readText(response, requestSignal)); } catch { value = undefined; }
        await response.body?.cancel().catch(() => undefined);
        throw providerFailure(value, response.status, response.headers.get('x-request-id'));
      }
      return response;
    }, signal);
  }

  /** Registration whose credentials are currently usable, or undefined. Never cached. */
  private async authorizedRegistration(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.credentials.status) return undefined;
    const status = await this.credentials.status(signal);
    const row = status.activeId ? status.registrations?.find(candidate => candidate.id === status.activeId) : undefined;
    return row?.authenticated && row.planAllowed ? row.id : undefined;
  }

  /** Cached, then saved (refreshing in the background), then a fresh account GET. */
  override async listModels(provider: string, callerSignal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const generation = this.catalogGeneration;
    const registrationId = await this.authorizedRegistration(callerSignal).catch(() => undefined);
    const current = this.catalog;
    if (current && current.provider === provider && registrationId === current.registrationId) {
      if (current.expiresAt <= Date.now()) this.refreshInBackground(provider);
      return structuredClone(current.models);
    }
    if (registrationId && this.options.catalogStore) {
      const stored = await this.options.catalogStore.load(registrationId).catch(() => undefined);
      if (stored?.length && generation === this.catalogGeneration) {
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

  /** Explicit refresh: always a fresh account request. A background refresh keeps the current list on failure. */
  async listModelsFresh(provider: string, callerSignal?: AbortSignal, keepCurrent = false): Promise<readonly LlmModelInfo[]> {
    if (!keepCurrent) this.catalog = undefined;
    const generation = this.catalogGeneration;
    let registrationId: string | undefined;
    const controller = new AbortController(); this.requests.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000), ...(callerSignal ? [callerSignal] : [])]);
    let response: Response | undefined;
    try {
      response = await this.request('models', signal, () => undefined, id => { registrationId = id; });
      const value: unknown = JSON.parse(await readText(response, signal));
      if (!object(value) || !Array.isArray(value.models)) throw new BridgeError('INVALID_MODEL_CATALOG', 'アカウントのモデル一覧を読み取れませんでした。');
      const models: LlmModelInfo[] = []; const slugs = new Set<string>();
      for (const raw of value.models) {
        // Entries that cannot be shown are skipped; the rest of the list stays usable.
        if (!object(raw) || raw.visibility !== 'list' || typeof raw.slug !== 'string' || !raw.slug.trim() || raw.slug.length > 200 || slugs.has(raw.slug)) continue;
        const name = typeof raw.display_name === 'string' && raw.display_name.trim() && raw.display_name.length <= 200 ? raw.display_name : raw.slug;
        slugs.add(raw.slug); models.push({ provider, id: raw.slug, name, inputModalities: [...INPUT_MODALITIES] });
      }
      if (registrationId && generation === this.catalogGeneration) {
        this.catalog = { provider, registrationId, expiresAt: Date.now() + CATALOG_TTL_MS, models: structuredClone(models) };
        await this.options.catalogStore?.save(registrationId, models.map(model => ({ id: model.id, name: model.name ?? model.id }))).catch(() => undefined);
      }
      return models;
    } catch (error) {
      if (!keepCurrent) this.discardCatalog();
      const failure = classify(error, signal);
      this.diagnostics.record({ kind: 'models', outcome: failure.code, http: response?.status ?? (error instanceof BridgeError ? error.status : undefined), request_id: error instanceof BridgeError ? label(error.requestId, 160) : undefined });
      throw failure;
    } finally { this.requests.delete(controller); await response?.body?.cancel().catch(() => undefined); }
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // The catalog is selector data, not an entitlement check; a model missing from it is still tried and the service decides.
    const models = await this.listModels(provider, signal).catch(() => [] as readonly LlmModelInfo[]);
    const selected = models.find(candidate => candidate.id === model) ?? { provider, id: model, name: model, inputModalities: [...INPUT_MODALITIES] };
    const reasoning = reasoningForModel(model);
    const context = contextForModel(model);
    return { ...selected, systemPromptUpdate: 'in-history', ...(reasoning ? { reasoning } : {}), ...(context ? { context } : {}) };
  }

  /**
   * Read request versions of attached images through DSH's attachment service.
   * Offloaded images become DSH's placeholder text; when the request would carry
   * too many image bytes, DSH is asked to offload the oldest ones and retry.
   */
  private async prepareMedia(options: GenerateOptions, signal: AbortSignal, notes: Notes): Promise<{ options: GenerateOptions; media?: RequestMedia }> {
    if (!options.messages.some(message => contentHasImage(message.content))) return { options };
    const attachments = this.options.attachments?.();
    const access = (ref: ImageAttachmentRef) => attachments ? this.options.imageAccess?.(attachments, ref) : undefined;
    const messages = projectOffloadedImages(options.messages, ref => offloadedImageText(ref, access(ref)));
    if (!attachments) { notes.add('request.attachment_service_missing'); return { options: { ...options, messages: [...messages] } }; }
    const refs = new Map<string, ImageAttachmentRef>();
    for (const message of messages) for (const block of message.content) if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment);
    const images = new Map<string, RequestImage & { bytes: number }>();
    for (const ref of refs.values()) {
      signal.throwIfAborted();
      try {
        const size = requestImageSize(ref.width, ref.height, IMAGE_POLICY.maxPixels);
        const version = await attachments.readImageRequest(ref, { ...size, maxBytes: IMAGE_POLICY.maxBytes }, signal);
        images.set(ref.attachmentId, { data: version.data, mediaType: version.mediaType, width: version.width, height: version.height, bytes: version.bytes });
      } catch (error) { if (signal.aborted) throw error; notes.add('request.image_read_failed'); }
    }
    const offloadImages = requiredImageOffload(messages, { representation: 'base64', maxBytes: IMAGE_POLICY.maxRequestBase64 }, block => images.get(block.attachment.attachmentId)?.bytes ?? 0);
    if (offloadImages > 0) throw new LlmError(`添付画像の合計が大きいため、古い画像${offloadImages}枚を文字の参照に置き換えて再実行します。`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
    return { options: { ...options, messages: [...messages] }, media: { images, handle: (ref, version) => requestImageHandleText(ref, version, access(ref)) } };
  }

  /**
   * One web search through the ChatGPT plan (hosted `web_search` on the SIWC route).
   * Same pause, sign-out cancellation, failure mapping and diagnostics as a turn.
   */
  async webSearch(request: WebSearchRequest & { model: string }, callerSignal?: AbortSignal): Promise<WebSearchResult> {
    const notes = new Notes(); const started = Date.now();
    const controller = new AbortController(); this.requests.add(controller);
    let signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS), ...(callerSignal ? [callerSignal] : [])]);
    let scope: { signal: AbortSignal; close(): void } | undefined;
    let response: Response | undefined;
    let outcome = 'ok';
    let failure: LlmError | undefined;
    try {
      const query = checkedQuery(request.query);
      if (this.paused) throw new BridgeError('USAGE_PAUSED', `ChatGPTプランの利用上限のため、新しい要求を止めています。${MANAGE_USAGE} で確認してから /siwc resume を実行してください。`);
      scope = await this.credentials.openRequestScope?.(signal);
      if (scope) signal = AbortSignal.any([signal, scope.signal]);
      response = await this.request('inference', signal, () => searchRequest(query, request.model, searchEffort(request.model)));
      const collector = new SearchCollector(notes);
      for await (const event of readSse(response.body ?? new ReadableStream(), signal, notes)) {
        collector.accept(event);
        if (collector.completed) break;
      }
      if (!collector.completed) throw new BridgeError('STREAM_INTERRUPTED', 'Web検索の応答が完了する前に途切れました。');
      return collector.result(request.maxResults);
    } catch (error) {
      // Web search is allowed per model and account/workspace policy; say so instead of a generic refusal.
      const refused = error instanceof ProviderFailure && (error.code === 'subscription_sharing_unsupported_capability' || (error.status === 400 && /^tool/.test(error.param ?? '')));
      failure = classify(refused ? new BridgeError('SEARCH_UNAVAILABLE', `このモデルまたはアカウント（workspace）の設定では、ChatGPTプラン経由のWeb検索を使えません。別のモデルを選ぶか、ChatGPTの設定を確認してください。`, error.status, error.requestId) : error, signal);
      outcome = failure.code;
      if (failure instanceof SiwcLlmError && failure.providerCode === USAGE_LIMIT) this.paused = true;
      throw failure;
    } finally {
      controller.abort(); scope?.close(); this.requests.delete(controller);
      await response?.body?.cancel().catch(() => undefined);
      const native = failure instanceof SiwcLlmError ? failure : undefined;
      this.diagnostics.record({
        kind: 'search', model: label(request.model, 80), outcome, provider_code: native && native.providerCode !== outcome ? label(native.providerCode) : undefined,
        http: response?.status ?? native?.failure?.status, request_id: label(response?.headers.get('x-request-id') ?? native?.failure?.requestId, 160),
        ms: Date.now() - started, notes: notes.size ? notes.list().join(',') : undefined,
      });
    }
  }

  /**
   * PDFs recorded by read_pdf results, newest first within the request budget. A URL is
   * downloaded by the service; a stored file is read back from DSH's attachment store.
   */
  private async prepareDocuments(options: GenerateOptions, signal: AbortSignal, notes: Notes): Promise<Map<string, RequestDocument>> {
    const documents = new Map<string, RequestDocument>();
    const names = new Map<string, string>();
    for (const message of options.messages) if (message.role === 'assistant') for (const block of message.content) if (block.type === 'tool-call') names.set(block.id, block.name);
    let budget = MAX_REQUEST_DOCUMENT_BASE64;
    for (const message of [...options.messages].reverse()) {
      if (message.role !== 'tool' || names.get(message.toolCallId) !== PDF_TOOL) continue;
      for (const block of message.content) {
        if (block.type !== 'text') continue;
        for (const ref of parseDocuments(block.text).refs) {
          const key = documentKey(ref);
          if (documents.has(key) || this.failedDocuments.has(key)) continue;
          if (ref.kind === 'url') { documents.set(key, { fileUrl: ref.url, filename: 'document.pdf' }); continue; }
          const encoded = Math.ceil(ref.bytes / 3) * 4;
          if (ref.bytes > MAX_PDF_BYTES || encoded > budget) { notes.add('request.document_over_budget'); continue; }
          const store = this.options.attachments?.();
          if (!store?.readFileStream) { notes.add('request.document_store_missing'); continue; }
          try {
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of store.readFileStream({ attachmentId: ref.attachmentId as never, name: ref.name, bytes: ref.bytes }, signal)) {
              size += chunk.byteLength;
              if (size > ref.bytes) throw new BridgeError('DOCUMENT_CHANGED', 'stored PDF size changed');
              chunks.push(Buffer.from(chunk));
            }
            const data = Buffer.concat(chunks).toString('base64');
            budget -= data.length;
            documents.set(key, { fileData: data, filename: documentFileName(ref.name) });
          } catch (error) { if (signal.aborted) throw error; notes.add('request.document_read_failed'); }
        }
      }
    }
    return documents;
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const notes = new Notes(); const started = Date.now();
    const controller = new AbortController(); this.requests.add(controller);
    const idle = new AbortController();
    const idleMs = this.options.idleTimeoutMs ?? 300_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new DOMException('idle', 'TimeoutError')), idleMs); };
    let signal = AbortSignal.any([controller.signal, idle.signal, ...(options.signal ? [options.signal] : [])]);
    let scope: { signal: AbortSignal; check?(): Promise<void>; close(): void } | undefined;
    let response: Response | undefined;
    let registrationId: string | undefined;
    let outcome = 'ok';
    let failure: LlmError | undefined;
    try {
      if (this.paused) throw new BridgeError('USAGE_PAUSED', `ChatGPTプランの利用上限のため、新しい要求を止めています。${MANAGE_USAGE} で確認してから /siwc resume を実行してください。`);
      scope = await this.credentials.openRequestScope?.(signal);
      if (scope) signal = AbortSignal.any([signal, scope.signal]);
      const prepared = await this.prepareMedia(options, signal, notes);
      touch();
      const toolNames = new Map<string, string>();
      const documents = await this.prepareDocuments(prepared.options, signal, notes);
      const send = (attached: ReadonlyMap<string, RequestDocument>) => this.request('inference', signal,
        id => buildRequest(prepared.options, { registrationId: id, media: prepared.media, notes, toolNames, documents: attached }), id => { registrationId = id; });
      try { response = await send(documents); }
      catch (error) {
        if (!documents.size || !documentRejected(error)) throw error;
        // The service could not use an attached PDF: send the turn once more with notes instead,
        // and stop attaching those PDFs only when that succeeds.
        notes.add('request.document_rejected');
        response = await send(new Map());
        for (const key of documents.keys()) this.failedDocuments.add(key);
      }
      touch();
      const stream = new ResponseStream(options.model, notes, registrationId, toolNames);
      for await (const event of readSse(response.body ?? new ReadableStream(), signal, notes)) {
        touch();
        for (const chunk of stream.accept(event)) yield chunk;
        if (stream.completed) break;
      }
      stream.end();
    } catch (error) {
      failure = classify(error, signal);
      outcome = failure.code;
      if (failure instanceof SiwcLlmError && failure.providerCode === USAGE_LIMIT) this.paused = true;
      throw failure;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      controller.abort(); scope?.close(); this.requests.delete(controller);
      await response?.body?.cancel().catch(() => undefined);
      const native = failure instanceof SiwcLlmError ? failure : undefined;
      this.diagnostics.record({
        kind: 'inference', model: label(options.model, 80), outcome, provider_code: native && native.providerCode !== outcome ? label(native.providerCode) : undefined,
        http: response?.status ?? native?.failure?.status, request_id: label(response?.headers.get('x-request-id') ?? native?.failure?.requestId, 160),
        ms: Date.now() - started, effort: label(options.reasoningEffort), purpose: label(options.purpose), notes: notes.size ? notes.list().join(',') : undefined,
      });
    }
  }
}
