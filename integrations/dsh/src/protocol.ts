import type { GenerateOptions, RequestMessage, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from './errors.js';
import { reasoningRequest } from './reasoning.js';

export const TOOL_NAMESPACE = 'dsh';
const MAX_EVENT = 2 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code = 'INVALID_STREAM', reason = 'stream.schema_invalid'): never {
  // Every caller supplies a static schema label, safe numeric position, or
  // the explicitly filtered event.type below. Never interpolate response values.
  throw new BridgeError(code, `SIWC応答の形式または完了状態を確認できませんでした。(reason=${reason})`);
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value);

/** Only machine labels are retained. Provider messages/detail can reflect submitted secrets or text. */
const diagnostic = (value: unknown, pattern: RegExp, maximum: number): string | undefined =>
  typeof value === 'string' && value.length <= maximum && pattern.test(value) ? value : undefined;

function invalid(reason: string, event?: Record<string, unknown>): never {
  const position = event ? ['sequence_number', 'output_index', 'content_index', 'streamed_count', 'completed_count']
    .filter(key => integer(event[key])).map(key => `;${key}=${event[key]}`).join('') : '';
  return fail('INVALID_STREAM', reason + position);
}

function unsupportedEvent(type: string): never {
  const safeType = diagnostic(type, /^response\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/, 120) ?? 'redacted';
  return fail('UNSUPPORTED_STREAM_EVENT', `event.type=${safeType}`);
}

export class ProviderFailure extends BridgeError {
  constructor(code: string, message: string, status?: number, requestId?: string,
    public readonly param?: string, public readonly responseShape = 'other') {
    super(code, message, status, requestId);
  }
}

export function providerFailure(body: unknown, status?: number, requestId?: unknown): ProviderFailure {
  const root = object(body) ? body : {};
  const detail = object(root.error) ? root.error : root;
  const code = diagnostic(typeof root.error === 'string' ? root.error : detail.code, /^[a-z][a-z0-9_]*$/, 100)
    ?? (status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limit' : status === 503 ? 'service_unavailable' : 'provider_error');
  const param = diagnostic(detail.param, /^[A-Za-z0-9_.\[\]-]+$/, 120);
  const id = diagnostic(requestId ?? root.request_id, /^[A-Za-z0-9_-]+$/, 160);
  const shape = object(root.error) ? 'structured_error' : typeof root.error === 'string' ? 'oauth_error' : typeof root.detail === 'string' ? 'detail' : 'other';
  const messages: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: 'ChatGPTプラン利用の上限に達しました。公式Usage画面を確認し、再開は本人の操作で行ってください。',
    subscription_sharing_usage_unavailable: 'ChatGPTの利用枠を確認できません。資格情報を保持し、時間を置いて再実行してください。',
    subscription_sharing_user_not_eligible: '選択したアカウントまたはworkspaceではChatGPTプラン利用を許可されていません。',
    subscription_sharing_unsupported_capability: 'SIWCで未対応の機能が要求されました。設定を確認してください。',
  };
  return new ProviderFailure(code, messages[code] ?? 'SIWC要求が拒否または中断されました。秘密を含み得るサービス本文は表示しません。', status, id, param, shape);
}

/** Encoded request version of one attached image, prepared by the adapter from DSH's attachment service. */
export interface RequestImage { data: Uint8Array; mediaType: string; width: number; height: number }
/** Images ready to send, plus the model-facing handle text DSH uses for every image occurrence. */
export interface RequestMedia {
  images: ReadonlyMap<string, RequestImage>;
  handle: (ref: ImageAttachmentRef, version: RequestImage) => string;
}
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function textContent(message: RequestMessage): string {
  return message.content.map(block => {
    if (block.type !== 'text') throw new BridgeError('UNSUPPORTED_CONTENT', message.role === 'user' || message.role === 'tool'
      ? 'この添付は送信形式に変換できませんでした。DSHを再起動して添付し直してください。'
      : 'system・developer・assistantの履歴には画像やファイルを含められません。');
    return block.text;
  }).join('\n');
}

/** User and tool content: text, plus images as native Responses input parts. Files never reach here (DSH projects them to text). */
function richContent(message: RequestMessage, media?: RequestMedia): string | Record<string, unknown>[] {
  if (!message.content.some(block => block.type === 'image')) return textContent(message);
  if (!media) throw new BridgeError('UNSUPPORTED_CONTENT', '画像を読み込めませんでした。DSHの添付機能が有効か確認してください。');
  const parts: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === 'text') { if (block.text !== '') parts.push({ type: 'input_text', text: block.text }); continue; }
    if (block.type !== 'image') throw new BridgeError('UNSUPPORTED_CONTENT', 'この添付は送信形式に変換できませんでした。DSHを再起動して添付し直してください。');
    const version = media.images.get(block.attachment.attachmentId);
    if (!version || !IMAGE_TYPES.has(version.mediaType) || !(version.data instanceof Uint8Array) || version.data.byteLength === 0) {
      throw new BridgeError('UNSUPPORTED_CONTENT', '添付画像を送信用に準備できませんでした。添付し直してください。');
    }
    parts.push({ type: 'input_text', text: media.handle(block.attachment, version) });
    parts.push({ type: 'input_image', image_url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`, detail: 'auto' });
  }
  return parts;
}

function functionItem(value: unknown, allowed?: ReadonlySet<string>): Record<string, unknown> {
  if (!object(value) || value.type !== 'function_call' || !identifier(value.call_id) || !identifier(value.name)
    || value.namespace !== TOOL_NAMESPACE || typeof value.arguments !== 'string' || value.arguments.length > MAX_EVENT
    || (value.status !== undefined && value.status !== 'completed') || value.async === true
    || (object(value.caller) && value.caller.type !== 'direct') || (allowed && !allowed.has(value.name))) fail('INVALID_TOOL_CALL', 'function_call.schema_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(value.arguments); } catch { fail('INVALID_TOOL_ARGUMENTS', 'function_call.arguments_json_invalid'); }
  if (!object(parsed)) fail('INVALID_TOOL_ARGUMENTS', 'function_call.arguments_object_required');
  return structuredClone(value);
}

/** Build an allowlisted request; ordinary API options never pass through. */
export function buildRequest(options: GenerateOptions, registrationId?: string, media?: RequestMedia): Record<string, unknown> {
  const allowed = new Set(['provider', 'model', 'messages', 'system', 'tools', 'toolHistory', 'signal', 'sessionId', 'purpose', 'reasoningEffort']);
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !allowed.has(key)) throw new BridgeError('UNSUPPORTED_OPTION', `SIWC初期版では ${/^[A-Za-z_]+$/.test(key) ? key : '指定されたオプション'} に対応していません。`);
  }
  if (!identifier(options.model) || !Array.isArray(options.messages)) throw new BridgeError('INVALID_REQUEST', 'モデルと会話履歴を指定してください。');
  const reasoning = reasoningRequest(options.model, options.reasoningEffort);
  const input: Record<string, unknown>[] = [];
  if (options.system !== undefined) input.push({ role: 'developer', content: options.system });
  const calls = new Map<string, string>();
  const answered = new Set<string>();
  for (const message of options.messages) {
    if (message.role === 'tool') {
      if (!calls.has(message.toolCallId) || answered.has(message.toolCallId)) throw new BridgeError('INVALID_TOOL_HISTORY', 'ツール結果のcall IDに対応する呼出しがないか、結果が重複しています。');
      answered.add(message.toolCallId);
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: richContent(message, media) });
      continue;
    }
    if (message.role === 'assistant') {
      const state = message.source.replayState;
      if (state !== undefined) {
        if (!object(state) || !object(state.response) || state.response.kind !== 'siwc-responses' || (state.response.version !== 1 && state.response.version !== 2)
          || !identifier(state.response.model) || !Array.isArray(state.response.output)) throw new BridgeError('INVALID_REPLAY_STATE', 'SIWC会話履歴の再利用情報が不正です。');
        if (registrationId !== undefined && (state.response.version !== 2 || state.response.registrationId !== registrationId)) {
          throw new BridgeError('INVALID_REPLAY_CONTEXT', '会話の内部履歴は元の登録だけで再利用できます。登録を切り替えた場合や旧版の会話は、新しい会話を開始してください。');
        }
        if (state.response.version === 2 && !identifier(state.response.registrationId)) throw new BridgeError('INVALID_REPLAY_STATE', 'SIWC会話履歴の登録情報が不正です。');
        const sameModel = state.response.model === options.model;
        const replayCalls = new Set<string>();
        for (const raw of state.response.output) {
          if (!object(raw) || !['message', 'reasoning', 'function_call'].includes(String(raw.type))) throw new BridgeError('INVALID_REPLAY_STATE', 'SIWC会話履歴の再利用情報が不正です。');
          if (raw.type === 'function_call') {
            const call = functionItem(raw);
            if (calls.has(String(call.call_id)) || replayCalls.has(String(call.call_id))) throw new BridgeError('INVALID_TOOL_HISTORY', 'ツールcall IDが重複しています。');
            replayCalls.add(String(call.call_id));
            if (sameModel) calls.set(String(call.call_id), String(call.name));
            const block = message.content.find(block => block.type === 'tool-call' && block.id === call.call_id);
            if (!block || block.type !== 'tool-call' || block.name !== call.name || block.arguments !== call.arguments) throw new BridgeError('INVALID_REPLAY_STATE', '保存された呼出しと再利用情報が一致しません。');
          }
          if (raw.type === 'message' && (raw.role !== 'assistant' || !Array.isArray(raw.content)
            || raw.content.some(part => !object(part) || !['output_text', 'refusal'].includes(String(part.type))
              || typeof (part.type === 'output_text' ? part.text : part.refusal) !== 'string'))) throw new BridgeError('INVALID_REPLAY_STATE', '再利用するassistantメッセージの形式が不正です。');
          if (sameModel) input.push(structuredClone(raw));
        }
        const nativeVisible = [...state.response.output.filter(raw => (raw as Record<string, unknown>).type === 'message'),
          ...state.response.output.filter(raw => (raw as Record<string, unknown>).type === 'function_call')].flatMap<Record<string, unknown>>(raw => {
          const item = raw as Record<string, unknown>;
          if (item.type === 'function_call') return [{ type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments }];
          if (item.type === 'message') return (item.content as Record<string, unknown>[]).map(part => ({ type: 'text', text: part.type === 'output_text' ? part.text : part.refusal }));
          return [];
        });
        const visible = nativeVisible.filter(part => part.type !== 'text' || part.text !== '');
        const canonical = message.content.map(block => block.type === 'text' ? { type: block.type, text: block.text }
          : block.type === 'tool-call' ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments } : { type: block.type });
        // The harness may have removed or rewritten content during compaction.
        // Never reintroduce pre-compaction text or calls through opaque metadata.
        const snapshot = state.response.visible;
        if (snapshot === undefined) {
          // Legacy v1 envelopes used the native text/call order.
          if (JSON.stringify(visible) !== JSON.stringify(canonical)) throw new BridgeError('INVALID_REPLAY_STATE', '現在の会話contentとSIWC再利用情報が一致しません。');
        } else {
          if (!Array.isArray(snapshot) || !isDeepStrictEqual(snapshot, canonical)) throw new BridgeError('INVALID_REPLAY_STATE', '現在の会話contentとSIWC表示順の保存情報が一致しません。');
          // A terminal-only item can arrive after another item's live text.
          // Verify the actual display order separately, while requiring exactly
          // the same native text/call values and multiplicities in that order.
          const inventory = (parts: Record<string, unknown>[]) => parts.filter(part => part.type !== 'text' || part.text !== '').map(part => JSON.stringify(part)).sort();
          const emptyTexts = (parts: Record<string, unknown>[]) => parts.filter(part => part.type === 'text' && part.text === '').length;
          if (!isDeepStrictEqual(inventory(snapshot), inventory(visible)) || emptyTexts(snapshot) > emptyTexts(nativeVisible)) throw new BridgeError('INVALID_REPLAY_STATE', '保存された表示内容とネイティブ応答の内容または個数が一致しません。');
        }
        // Opaque reasoning is never interpreted or converted to a visible reasoning block.
        if (sameModel) continue;
        // A model change keeps explicit text, call IDs and tool results, while
        // rebuilding them below without the previous model's opaque reasoning/item IDs.
      }
      for (const block of message.content) {
        if (block.type === 'text') input.push({ role: 'assistant', content: block.text });
        else if (block.type === 'tool-call') {
          if (calls.has(block.id)) throw new BridgeError('INVALID_TOOL_HISTORY', 'ツールcall IDが重複しています。');
          const call = functionItem({ type: 'function_call', namespace: TOOL_NAMESPACE, call_id: block.id, name: block.name, arguments: block.arguments });
          calls.set(block.id, block.name); input.push(call);
        } else throw new BridgeError('UNSUPPORTED_CONTENT', 'ネイティブ再利用情報のないreasoningや非テキスト履歴は送信できません。');
      }
      continue;
    }
    if (!['system', 'developer', 'user'].includes(message.role)) throw new BridgeError('UNSUPPORTED_CONTENT', '未対応の会話roleです。');
    if (message.role === 'user') {
      const content = richContent(message, media);
      if (content !== '' && !(Array.isArray(content) && content.length === 0)) input.push({ role: 'user', content });
      continue;
    }
    const text = textContent(message);
    if (text !== '') input.push({ role: message.role === 'system' ? 'developer' : message.role, content: text });
  }
  const body: Record<string, unknown> = { model: options.model, input, store: false, stream: true };
  if (reasoning) body.reasoning = reasoning;
  if (options.tools?.length) {
    const names = new Set<string>();
    body.tools = [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed by the local DeepSeek Harness with its existing approval policy.',
      tools: options.tools.map(tool => {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name) || !object(tool.parameters) || tool.deferLoading) throw new BridgeError('UNSUPPORTED_TOOL', 'tool名・schema・deferred loadingを確認してください。');
        names.add(tool.name);
        return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
      }) }];
  }
  return body;
}

/** SSE framing is independent of the HTTP transport and accepts arbitrarily split UTF-8 bytes. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  const parse = (frame: string): Record<string, unknown> | undefined => {
    const data: string[] = []; let type: string | undefined;
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line === '' || line.startsWith(':') || /^(id|retry):/.test(line)) continue;
      else invalid('sse.frame_field_invalid');
    }
    if (!data.length) return undefined;
    const value = data.join('\n');
    if (value === '[DONE]') return undefined; // This marker does not establish Responses completion.
    let event: unknown; try { event = JSON.parse(value); } catch { invalid('sse.json_invalid'); }
    if (!object(event)) invalid('sse.event_object_required');
    if (typeof event.type !== 'string') invalid('sse.event_type_string_required');
    if (type !== undefined && type !== event.type) invalid('sse.event_name_mismatch');
    return event;
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) { pending += decoder.decode(); break; }
      total += value.byteLength;
      if (total > MAX_RESPONSE) fail('RESPONSE_TOO_LARGE', 'sse.response_byte_limit');
      pending += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > MAX_EVENT) fail('RESPONSE_TOO_LARGE', 'sse.event_size_limit');
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const event = parse(frame); if (event) yield event;
      }
      if (pending.length > MAX_EVENT) fail('RESPONSE_TOO_LARGE', 'sse.pending_event_size_limit');
    }
    if (pending.trim() !== '') fail('STREAM_INTERRUPTED', 'sse.unterminated_frame');
  } catch (error) {
    if (signal?.aborted) throw new BridgeError('CANCELLED', '中断しました。');
    if (error instanceof BridgeError) throw error;
    invalid('sse.read_or_utf8_failure');
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function mapUsage(value: unknown): TokenUsage | undefined {
  if (!object(value) || !integer(value.input_tokens) || !integer(value.output_tokens)) return undefined;
  const inputDetails = object(value.input_tokens_details) ? value.input_tokens_details : {};
  const cached = inputDetails.cached_tokens, written = inputDetails.cache_write_tokens;
  if ((cached !== undefined && !integer(cached)) || (written !== undefined && !integer(written))) return undefined;
  const cacheRead = Number(cached ?? 0), cacheWrite = Number(written ?? 0);
  if (cacheRead + cacheWrite > value.input_tokens) return undefined;
  const usage: TokenUsage = { inputTokens: value.input_tokens - cacheRead - cacheWrite, outputTokens: value.output_tokens };
  if (cached !== undefined) usage.cacheReadTokens = cacheRead;
  if (written !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (integer(value.total_tokens) && value.total_tokens === value.input_tokens + value.output_tokens) usage.totalTokens = value.total_tokens;
  const outputDetails = object(value.output_tokens_details) ? value.output_tokens_details : {};
  if (integer(outputDetails.reasoning_tokens) && outputDetails.reasoning_tokens <= value.output_tokens) usage.reasoningTokens = outputDetails.reasoning_tokens;
  return usage;
}

interface ItemState { item: Record<string, unknown>; done?: Record<string, unknown>; fragments: string[]; argumentsLength: number; argumentsDone?: string }
interface TextState { index: number; itemId: string; outputIndex: number; contentIndex: number; text: string; closed: boolean }

/** Text is visible while streaming; every tool chunk is withheld until the entire response completes. */
export class ResponseStream {
  readonly items = new Map<number, ItemState>();
  private readonly texts = new Map<string, TextState>();
  private nextIndex = 0;
  private sequence = -1;
  completed = false;
  constructor(private readonly model: string, private readonly allowedTools: ReadonlySet<string> = new Set(), private readonly registrationId?: string) {}

  private item(event: Record<string, unknown>): ItemState {
    if (!integer(event.output_index)) invalid('event_item.output_index_invalid', event);
    const state = this.items.get(event.output_index);
    if (!state) invalid('event_item.output_index_not_started', event);
    if (!identifier(event.item_id)) invalid('event_item.item_id_invalid', event);
    if (state.item.id !== event.item_id) invalid('event_item.item_id_mismatch', event);
    return state;
  }

  private text(outputIndex: number, contentIndex: number, itemId: string, delta: string): StreamChunk[] {
    const key = `${outputIndex}:${contentIndex}`;
    let state = this.texts.get(key); const chunks: StreamChunk[] = [];
    if (!state) {
      state = { index: this.nextIndex++, itemId, outputIndex, contentIndex, text: '', closed: false };
      this.texts.set(key, state); chunks.push({ type: 'block-start', index: state.index, blockType: 'text' });
    }
    if (state.closed) invalid('text.delta_after_block_closed');
    if (state.itemId !== itemId) invalid('text.item_id_mismatch');
    state.text += delta;
    if (state.text.length > MAX_RESPONSE) fail('RESPONSE_TOO_LARGE', 'text.block_size_limit');
    if (delta !== '') chunks.push({ type: 'text-delta', index: state.index, text: delta });
    return chunks;
  }

  accept(event: Record<string, unknown>): StreamChunk[] {
    if (this.completed) invalid('event.after_response_completed', event);
    if (typeof event.type !== 'string') invalid('event.type_string_required', event);
    if (event.sequence_number !== undefined) {
      if (!integer(event.sequence_number)) invalid('event.sequence_number_invalid', event);
      if (event.sequence_number <= this.sequence) invalid('event.sequence_number_not_increasing', event);
      this.sequence = event.sequence_number;
    }
    if (event.type === 'response.failed' || event.type === 'error') throw providerFailure(event.type === 'response.failed' ? event.response : event);
    if (event.type === 'response.incomplete') fail('RESPONSE_INCOMPLETE', 'response.incomplete');
    if (event.type === 'response.output_item.added') {
      if (!integer(event.output_index)) invalid('output_item_added.output_index_invalid', event);
      if (!object(event.item)) invalid('output_item_added.item_object_required', event);
      if (!identifier(event.item.id)) invalid('output_item_added.item_id_invalid', event);
      if (this.items.has(event.output_index)) invalid('output_item_added.duplicate_output_index', event);
      if (!['message', 'function_call', 'reasoning'].includes(String(event.item.type))) invalid('output_item_added.item_type_unsupported', event);
      this.items.set(event.output_index, { item: structuredClone(event.item), fragments: [], argumentsLength: 0 });
    } else if (event.type === 'response.function_call_arguments.delta') {
      const state = this.item(event);
      if (state.item.type !== 'function_call') invalid('arguments_delta.item_type_mismatch', event);
      if (state.done) invalid('arguments_delta.after_item_done', event);
      if (state.argumentsDone !== undefined) invalid('arguments_delta.after_arguments_done', event);
      if (typeof event.delta !== 'string') invalid('arguments_delta.delta_string_required', event);
      state.fragments.push(event.delta);
      state.argumentsLength += event.delta.length;
      if (state.argumentsLength > MAX_EVENT) fail('RESPONSE_TOO_LARGE', 'arguments_delta.size_limit');
    } else if (event.type === 'response.function_call_arguments.done') {
      const state = this.item(event);
      if (state.item.type !== 'function_call' || state.done || state.argumentsDone !== undefined || typeof event.arguments !== 'string'
        || (state.fragments.length > 0 && state.fragments.join('') !== event.arguments)) fail('INVALID_TOOL_ARGUMENTS', 'arguments_done.schema_or_fragments_mismatch');
      state.argumentsDone = event.arguments;
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const state = this.item(event);
      if (state.item.type !== 'message') invalid('text_delta.item_type_mismatch', event);
      if (state.done) invalid('text_delta.after_item_done', event);
      if (!integer(event.content_index)) invalid('text_delta.content_index_invalid', event);
      if (typeof event.delta !== 'string') invalid('text_delta.delta_string_required', event);
      return this.text(Number(event.output_index), event.content_index, String(event.item_id), event.delta);
    } else if (event.type === 'response.output_item.done') {
      if (!integer(event.output_index)) invalid('output_item_done.output_index_invalid', event);
      if (!object(event.item)) invalid('output_item_done.item_object_required', event);
      const state = this.items.get(event.output_index);
      if (!state) invalid('output_item_done.output_index_not_started', event);
      if (state.done) invalid('output_item_done.duplicate_done', event);
      if (state.item.id !== event.item.id) invalid('output_item_done.item_id_mismatch', event);
      if (state.item.type !== event.item.type) invalid('output_item_done.item_type_mismatch', event);
      if (event.item.status !== undefined && event.item.status !== 'completed') invalid('output_item_done.item_unfinished', event);
      if (event.item.type === 'function_call') {
        const call = functionItem(event.item, this.allowedTools);
        if ((state.argumentsDone !== undefined && state.argumentsDone !== call.arguments)
          || (state.fragments.length > 0 && state.fragments.join('') !== call.arguments)
          || state.item.call_id !== call.call_id || state.item.name !== call.name || state.item.namespace !== call.namespace) fail('INVALID_TOOL_CALL', 'output_item_done.function_call_mismatch');
      }
      state.done = structuredClone(event.item);
    } else if (event.type === 'response.completed') {
      if (!object(event.response)) invalid('completed.response_object_required', event);
      if (event.response.status !== 'completed') invalid('completed.response_status_mismatch', event);
      if (event.response.error !== undefined && event.response.error !== null) throw providerFailure(event.response);
      if (event.response.incomplete_details !== undefined && event.response.incomplete_details !== null) fail('RESPONSE_INCOMPLETE', 'completed.incomplete_details_present');
      if (!Array.isArray(event.response.output)) invalid('completed.output_array_required', event);
      const counts = { streamed_count: this.items.size, completed_count: event.response.output.length };
      let finalOutput: unknown[] = event.response.output;
      // Public streaming function calls can be assembled from their finished
      // output_item.done items. When the terminal aggregate is empty, use only
      // those complete items after normal response completion, never added items
      // or partially accumulated arguments. Require every index in order.
      if (finalOutput.length === 0 && this.items.size > 0) {
        finalOutput = [];
        for (let outputIndex = 0; outputIndex < this.items.size; outputIndex++) {
          const location = { ...counts, output_index: outputIndex };
          const state = this.items.get(outputIndex);
          if (!state) invalid('completed.streamed_output_index_gap', location);
          if (!state.done) invalid('completed.output_item_not_done', location);
          finalOutput.push(state.done);
        }
      }
      // The terminal Response contains the full native output array. It can
      // supply items absent from the observed events, but cannot drop or change
      // any item that this stream already started and completed.
      for (const [outputIndex, state] of this.items) {
        const location = { ...counts, output_index: outputIndex };
        if (outputIndex >= finalOutput.length) invalid('completed.output_item_count_mismatch', location);
        if (!state.done) invalid('completed.output_item_not_done', location);
        if (!isDeepStrictEqual(state.done, finalOutput[outputIndex])) invalid('completed.output_item_done_mismatch', location);
      }
      const output: Record<string, unknown>[] = [], calls: Record<string, unknown>[] = [], ids = new Set<string>();
      const itemIds = new Set<string>();
      const chunks: StreamChunk[] = [];
      for (let outputIndex = 0; outputIndex < finalOutput.length; outputIndex++) {
        const raw = finalOutput[outputIndex];
        if (!object(raw)) invalid('completed.output_item_object_required');
        if (!identifier(raw.id)) invalid('completed.output_item_id_invalid');
        if (!['message', 'reasoning', 'function_call'].includes(String(raw.type))) invalid('completed.output_item_type_unsupported');
        if (itemIds.has(raw.id)) invalid('completed.output_item_id_duplicate');
        itemIds.add(raw.id);
        if (raw.status !== undefined && raw.status !== 'completed') invalid('completed.output_item_unfinished');
        const state = this.items.get(outputIndex);
        if (state && !state.done) invalid('completed.output_item_not_done');
        if (state && state.item.id !== raw.id) invalid('completed.output_item_id_mismatch');
        if (state && state.item.type !== raw.type) invalid('completed.output_item_type_mismatch');
        // Complete reasoning comes from item.done, never item.added's potentially partial encrypted data.
        const item = state?.done ?? raw;
        if (raw.type === 'function_call') {
          const call = functionItem(raw, this.allowedTools);
          if (['id', 'type', 'call_id', 'namespace', 'name', 'arguments'].some(key => call[key] !== item[key]) || ids.has(String(call.call_id))) fail('INVALID_TOOL_CALL', 'completed.function_call_mismatch_or_duplicate');
          ids.add(String(call.call_id)); calls.push(call);
        } else if (raw.type === 'message') {
          if (raw.status !== 'completed') invalid('completed.message_status_mismatch');
          if (!Array.isArray(raw.content)) invalid('completed.message_content_array_required');
          if (raw.role !== 'assistant') invalid('completed.message_role_mismatch');
          for (let contentIndex = 0; contentIndex < raw.content.length; contentIndex++) {
            const part = raw.content[contentIndex];
            if (!object(part) || !['output_text', 'refusal'].includes(String(part.type))) fail('UNSUPPORTED_CONTENT', 'completed.content_part_type_unsupported');
            const full = part.type === 'output_text' ? part.text : part.refusal;
            if (typeof full !== 'string') invalid('completed.content_text_string_required');
            const text = this.texts.get(`${outputIndex}:${contentIndex}`);
            if (text && text.text !== full) invalid('completed.streamed_text_mismatch');
            if (!text && full !== '') chunks.push(...this.text(outputIndex, contentIndex, String(raw.id), full));
          }
        } else if (raw.type === 'reasoning') {
          if (!Array.isArray(raw.summary) || raw.summary.some(part => !object(part) || part.type !== 'summary_text' || typeof part.text !== 'string')) invalid('completed.reasoning_summary_invalid');
          if (raw.content !== undefined && (!Array.isArray(raw.content) || raw.content.some(part => !object(part) || part.type !== 'reasoning_text' || typeof part.text !== 'string'))) invalid('completed.reasoning_content_invalid');
          if (raw.encrypted_content !== undefined && raw.encrypted_content !== null && typeof raw.encrypted_content !== 'string') invalid('completed.reasoning_encrypted_content_invalid');
        }
        output.push(structuredClone(item));
      }
      for (const text of this.texts.values()) {
        const raw = output[text.outputIndex];
        if (!raw || raw.type !== 'message' || !Array.isArray(raw.content) || !raw.content[text.contentIndex]) invalid('completed.streamed_content_not_in_output');
        text.closed = true; chunks.push({ type: 'block-end', index: text.index, block: { type: 'text', text: text.text } });
      }
      for (const call of calls) {
        const index = this.nextIndex++, id = String(call.call_id) as ToolCallId;
        const state = [...this.items.values()].find(state => state.item.call_id === id);
        chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
        const fragments = state?.fragments.length ? state.fragments : [String(call.arguments)];
        for (const [offset, fragment] of fragments.entries()) chunks.push({ type: 'tool-call-delta', index, id, ...(offset === 0 ? { name: String(call.name) } : {}), argumentsDelta: fragment });
        chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id, name: String(call.name), arguments: String(call.arguments) } });
      }
      if (this.nextIndex === 0) fail('EMPTY_RESPONSE', 'completed.no_visible_blocks');
      const usage = mapUsage(event.response.usage); if (usage) chunks.push({ type: 'usage', usage });
      this.completed = true;
      const visible = chunks.filter(chunk => chunk.type === 'block-end').sort((a, b) => a.index - b.index).map(chunk =>
        chunk.block.type === 'text' ? { type: 'text', text: chunk.block.text }
          : chunk.block.type === 'tool-call' ? { type: 'tool-call', id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments } : { type: chunk.block.type });
      chunks.push({ type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' }, replayState: { response: { kind: 'siwc-responses', version: this.registrationId === undefined ? 1 : 2, ...(this.registrationId === undefined ? {} : { registrationId: this.registrationId }), model: this.model, output, visible } } });
      return chunks;
    } else if (!['response.created', 'response.in_progress', 'response.queued', 'response.content_part.added', 'response.content_part.done',
      'response.output_text.done', 'response.refusal.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(event.type)) unsupportedEvent(event.type);
    return [];
  }

  end(): void { if (!this.completed) fail('STREAM_INTERRUPTED', 'stream.response_completed_missing'); }
}
