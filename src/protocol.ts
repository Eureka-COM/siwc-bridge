import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from './errors.js';
import type { ClientEvent, CompletedResponse, FunctionCallItem, ResponseInputItem, ResponseOutputItem, ResponseRequest, TokenUsage } from './types.js';

const MAX_EVENT = 2 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value);
const toolName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const diagnostic = (value: unknown, pattern: RegExp, maximum: number): string | undefined =>
  typeof value === 'string' && value.length <= maximum && pattern.test(value) ? value : undefined;
function fail(code = 'INVALID_STREAM', reason = 'stream.schema_invalid'): never {
  throw new BridgeError(code, `SIWC応答または入力の形式を確認できませんでした。(reason=${reason})`);
}
function invalid(reason: string, event?: Record<string, unknown>): never {
  const position = event ? ['sequence_number', 'output_index', 'content_index', 'streamed_count', 'completed_count']
    .filter(key => integer(event[key])).map(key => `;${key}=${event[key]}`).join('') : '';
  return fail('INVALID_STREAM', reason + position);
}
/**
 * Events outside the Responses namespace (service notices such as rate-limit
 * snapshots or keep-alives) carry no output item, text or tool call. They are
 * skipped; a turn still succeeds only through response.completed. A type that
 * is not a plain machine label is never treated as a notice.
 */
export const serviceNotice = (type: string): boolean => type !== 'error' && !type.startsWith('response.') && type.length <= 120 && /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/.test(type);

function unsupportedEvent(type: string): never {
  const safeType = diagnostic(type, /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/, 120) ?? 'redacted';
  return fail('UNSUPPORTED_STREAM_EVENT', `event.type=${safeType}`);
}
export class ProviderFailure extends BridgeError {
  constructor(code: string, message: string, status?: number, requestId?: string,
    public readonly param?: string, public readonly responseShape = 'other') { super(code, message, status, requestId); }
}
export function providerFailure(body: unknown, status?: number, requestId?: unknown): ProviderFailure {
  const root = object(body) ? body : {}, detail = object(root.error) ? root.error : root;
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
function functionItem(value: unknown, allowed?: ReadonlySet<string>): FunctionCallItem {
  if (!object(value) || value.type !== 'function_call' || !identifier(value.call_id) || !toolName(value.name) || !toolName(value.namespace)
    || typeof value.arguments !== 'string' || value.arguments.length > MAX_EVENT
    || (value.status !== undefined && value.status !== 'completed') || value.async === true
    || (value.caller !== undefined && (!object(value.caller) || value.caller.type !== 'direct'))
    || (allowed && !allowed.has(`${value.namespace}/${value.name}`))) fail('INVALID_TOOL_CALL', 'function_call.schema_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(value.arguments); } catch { fail('INVALID_TOOL_ARGUMENTS', 'function_call.arguments_json_invalid'); }
  if (!object(parsed)) fail('INVALID_TOOL_ARGUMENTS', 'function_call.arguments_object_required');
  return structuredClone(value) as FunctionCallItem;
}
function nativeItem(value: unknown, allowed?: ReadonlySet<string>): ResponseOutputItem {
  if (!object(value) || !identifier(value.id)) invalid('native_item.id_invalid');
  if (value.status !== undefined && value.status !== 'completed') invalid('native_item.unfinished');
  if (value.type === 'function_call') return functionItem(value, allowed);
  if (value.type === 'message') {
    if (value.role !== 'assistant' || value.status !== 'completed' || !Array.isArray(value.content)) invalid('native_message.schema_invalid');
    for (const part of value.content) {
      if (!object(part) || !['output_text', 'refusal'].includes(String(part.type))) fail('UNSUPPORTED_CONTENT', 'native_message.content_type_unsupported');
      if (typeof (part.type === 'output_text' ? part.text : part.refusal) !== 'string') invalid('native_message.text_invalid');
    }
  } else if (value.type === 'reasoning') {
    if (!Array.isArray(value.summary) || value.summary.some(part => !object(part) || part.type !== 'summary_text' || typeof part.text !== 'string')) invalid('native_reasoning.summary_invalid');
    if (value.content !== undefined && (!Array.isArray(value.content) || value.content.some(part => !object(part) || part.type !== 'reasoning_text' || typeof part.text !== 'string'))) invalid('native_reasoning.content_invalid');
    if (value.encrypted_content !== undefined && value.encrypted_content !== null && typeof value.encrypted_content !== 'string') invalid('native_reasoning.encrypted_content_invalid');
  } else invalid('native_item.type_unsupported');
  return structuredClone(value) as ResponseOutputItem;
}
/** Validate the native stateless request before transport. This function cannot establish history provenance. */
export function buildRequest(options: ResponseRequest): Record<string, unknown> {
  if (!object(options)) fail('INVALID_REQUEST', 'request.object_required');
  const allowed = new Set(['model', 'input', 'tools', 'instructions', 'signal']);
  for (const [key, value] of Object.entries(options)) if (value !== undefined && !allowed.has(key)) fail('UNSUPPORTED_OPTION', 'request.option_unsupported');
  if (!identifier(options.model) || !Array.isArray(options.input)
    || (options.instructions !== undefined && typeof options.instructions !== 'string')
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail('INVALID_REQUEST', 'request.schema_invalid');
  const input: ResponseInputItem[] = [], calls = new Set<string>(), answered = new Set<string>(), itemIds = new Set<string>();
  for (const raw of options.input) {
    if (!object(raw)) fail('INVALID_REQUEST', 'input.item_object_required');
    if (raw.id !== undefined) {
      if (!identifier(raw.id) || itemIds.has(raw.id)) fail('INVALID_TOOL_HISTORY', 'input.item_id_duplicate_or_invalid');
      itemIds.add(raw.id);
    }
    if (raw.type === 'function_call_output') {
      if (!identifier(raw.call_id) || typeof raw.output !== 'string' || !calls.has(raw.call_id) || answered.has(raw.call_id)) fail('INVALID_TOOL_HISTORY', 'input.result_without_unique_call');
      if (Object.keys(raw).some(key => !['type', 'call_id', 'output', 'id', 'status'].includes(key))) fail('UNSUPPORTED_CONTENT', 'input.function_output_field_unsupported');
      if (raw.status !== undefined && raw.status !== 'completed') fail('INVALID_TOOL_HISTORY', 'input.result_unfinished');
      answered.add(raw.call_id); input.push(structuredClone(raw) as ResponseInputItem);
    } else if (raw.type === 'function_call') {
      const call = functionItem(raw);
      if (calls.has(call.call_id)) fail('INVALID_TOOL_HISTORY', 'input.call_id_duplicate');
      calls.add(call.call_id); input.push(call);
    } else if (raw.type === 'reasoning' || (raw.type === 'message' && raw.role === 'assistant' && raw.status !== undefined)) {
      input.push(nativeItem(raw));
    } else {
      if ((raw.type !== undefined && raw.type !== 'message') || !['system', 'developer', 'user', 'assistant'].includes(String(raw.role))) fail('UNSUPPORTED_CONTENT', 'input.message_role_or_type_unsupported');
      if (Object.keys(raw).some(key => !['type', 'role', 'content', 'id'].includes(key))) fail('UNSUPPORTED_CONTENT', 'input.message_field_unsupported');
      if (typeof raw.content !== 'string' && (!Array.isArray(raw.content) || raw.content.some(part => !object(part)
        || part.type !== 'input_text' || typeof part.text !== 'string' || Object.keys(part).some(key => !['type', 'text'].includes(key))))) fail('UNSUPPORTED_CONTENT', 'input.text_content_required');
      input.push({ ...structuredClone(raw), role: raw.role === 'system' ? 'developer' : raw.role } as ResponseInputItem);
    }
  }
  const body: Record<string, unknown> = { model: options.model, input, store: false, stream: true };
  if (options.instructions !== undefined) body.instructions = options.instructions;
  if (options.tools !== undefined) {
    if (!Array.isArray(options.tools)) fail('UNSUPPORTED_TOOL', 'tools.array_required');
    const namespaces = new Set<string>();
    body.tools = options.tools.map(namespace => {
      if (!object(namespace) || namespace.type !== 'namespace' || !toolName(namespace.name) || namespaces.has(namespace.name)
        || (namespace.description !== undefined && typeof namespace.description !== 'string') || !Array.isArray(namespace.tools)
        || Object.keys(namespace).some(key => !['type', 'name', 'description', 'tools'].includes(key))) fail('UNSUPPORTED_TOOL', 'tools.namespace_schema_invalid');
      namespaces.add(namespace.name); const names = new Set<string>();
      return { type: 'namespace', name: namespace.name, ...(namespace.description !== undefined ? { description: namespace.description } : {}), tools: namespace.tools.map(tool => {
        if (!object(tool) || tool.type !== 'function' || !toolName(tool.name) || names.has(tool.name) || !object(tool.parameters)
          || (tool.description !== undefined && typeof tool.description !== 'string') || (tool.strict !== undefined && tool.strict !== false)
          || Object.keys(tool).some(key => !['type', 'name', 'description', 'parameters', 'strict'].includes(key))) fail('UNSUPPORTED_TOOL', 'tools.function_schema_invalid');
        names.add(tool.name);
        return { type: 'function', name: tool.name, ...(tool.description !== undefined ? { description: tool.description } : {}), parameters: structuredClone(tool.parameters), strict: false };
      }) };
    });
  }
  return body;
}
/** SSE framing accepts arbitrarily split UTF-8 bytes. DONE alone never establishes completion. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
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
    const value = data.join('\n'); if (value === '[DONE]') return undefined;
    let event: unknown; try { event = JSON.parse(value); } catch { invalid('sse.json_invalid'); }
    if (!object(event)) invalid('sse.event_object_required');
    if (typeof event.type !== 'string') invalid('sse.event_type_string_required');
    if (type !== undefined && type !== event.type) invalid('sse.event_name_mismatch');
    return event;
  };
  try {
    for (;;) {
      signal?.throwIfAborted(); const { done, value } = await reader.read(); signal?.throwIfAborted();
      if (done) { pending += decoder.decode(); break; }
      total += value.byteLength; if (total > MAX_RESPONSE) fail('RESPONSE_TOO_LARGE', 'sse.response_byte_limit');
      pending += decoder.decode(value, { stream: true }); let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > MAX_EVENT) fail('RESPONSE_TOO_LARGE', 'sse.event_size_limit');
        const frame = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
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
    signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock();
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
interface ItemState { item: Record<string, unknown>; done?: Record<string, unknown>; fragments: string[]; argumentsLength: number; argumentsDone?: string; }
interface TextState { itemId: string; outputIndex: number; contentIndex: number; text: string; kind: 'output_text' | 'refusal'; }
/** Only live text and entirely validated completed responses cross the caller's execution boundary. */
export class ResponseStream {
  private readonly items = new Map<number, ItemState>();
  private readonly texts = new Map<string, TextState>();
  private sequence = -1;
  completed = false;
  constructor(private readonly model: string, private readonly allowedTools: ReadonlySet<string> = new Set()) {}
  private item(event: Record<string, unknown>): ItemState {
    if (!integer(event.output_index)) invalid('event_item.output_index_invalid', event);
    const state = this.items.get(event.output_index); if (!state) invalid('event_item.output_index_not_started', event);
    if (!identifier(event.item_id)) invalid('event_item.item_id_invalid', event);
    if (state.item.id !== event.item_id) invalid('event_item.item_id_mismatch', event);
    return state;
  }
  private text(outputIndex: number, contentIndex: number, itemId: string, delta: string, kind: 'output_text' | 'refusal'): ClientEvent[] {
    const key = `${outputIndex}:${contentIndex}`; let state = this.texts.get(key);
    if (!state) { state = { itemId, outputIndex, contentIndex, text: '', kind }; this.texts.set(key, state); }
    if (state.itemId !== itemId || state.kind !== kind) invalid('text.item_id_or_kind_mismatch');
    state.text += delta; if (state.text.length > MAX_RESPONSE) fail('RESPONSE_TOO_LARGE', 'text.block_size_limit');
    return delta === '' ? [] : [{ type: 'text.delta', text: delta }];
  }
  accept(event: Record<string, unknown>): ClientEvent[] {
    if (this.completed) invalid('event.after_response_completed', event);
    if (typeof event.type !== 'string') invalid('event.type_string_required', event);
    if (event.sequence_number !== undefined) {
      if (!integer(event.sequence_number)) invalid('event.sequence_number_invalid', event);
      if (event.sequence_number <= this.sequence) invalid('event.sequence_number_not_increasing', event);
      this.sequence = event.sequence_number;
    }
    if (event.type === 'response.failed' || event.type === 'error') throw providerFailure(event.type === 'response.failed' ? event.response : event);
    if (serviceNotice(event.type)) return [];
    if (event.type === 'response.incomplete') fail('RESPONSE_INCOMPLETE', 'response.incomplete');
    if (event.type === 'response.output_item.added') {
      if (!integer(event.output_index) || !object(event.item) || !identifier(event.item.id)) invalid('output_item_added.schema_invalid', event);
      if (this.items.has(event.output_index)) invalid('output_item_added.duplicate_output_index', event);
      if (!['message', 'function_call', 'reasoning'].includes(String(event.item.type))) invalid('output_item_added.item_type_unsupported', event);
      this.items.set(event.output_index, { item: structuredClone(event.item), fragments: [], argumentsLength: 0 });
    } else if (event.type === 'response.function_call_arguments.delta') {
      const state = this.item(event);
      if (state.item.type !== 'function_call' || state.done || state.argumentsDone !== undefined || typeof event.delta !== 'string') invalid('arguments_delta.schema_invalid', event);
      state.fragments.push(event.delta); state.argumentsLength += event.delta.length;
      if (state.argumentsLength > MAX_EVENT) fail('RESPONSE_TOO_LARGE', 'arguments_delta.size_limit');
    } else if (event.type === 'response.function_call_arguments.done') {
      const state = this.item(event);
      if (state.item.type !== 'function_call' || state.done || state.argumentsDone !== undefined || typeof event.arguments !== 'string'
        || (state.fragments.length > 0 && state.fragments.join('') !== event.arguments)) fail('INVALID_TOOL_ARGUMENTS', 'arguments_done.schema_or_fragments_mismatch');
      state.argumentsDone = event.arguments;
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const state = this.item(event);
      if (state.item.type !== 'message' || state.done || !integer(event.content_index) || typeof event.delta !== 'string') invalid('text_delta.schema_invalid', event);
      return this.text(Number(event.output_index), event.content_index, String(event.item_id), event.delta, event.type === 'response.refusal.delta' ? 'refusal' : 'output_text');
    } else if (event.type === 'response.output_item.done') {
      if (!integer(event.output_index) || !object(event.item)) invalid('output_item_done.schema_invalid', event);
      const state = this.items.get(event.output_index);
      if (!state || state.done || state.item.id !== event.item.id || state.item.type !== event.item.type) invalid('output_item_done.state_mismatch', event);
      if (event.item.status !== undefined && event.item.status !== 'completed') invalid('output_item_done.item_unfinished', event);
      if (event.item.type === 'function_call') {
        const call = functionItem(event.item, this.allowedTools);
        if ((state.argumentsDone !== undefined && state.argumentsDone !== call.arguments) || (state.fragments.length > 0 && state.fragments.join('') !== call.arguments)
          || ['call_id', 'name', 'namespace'].some(key => state.item[key] !== call[key])) fail('INVALID_TOOL_CALL', 'output_item_done.function_call_mismatch');
      }
      state.done = structuredClone(event.item);
    } else if (event.type === 'response.completed') {
      if (!object(event.response) || event.response.status !== 'completed') invalid('completed.response_schema_invalid', event);
      if (event.response.error !== undefined && event.response.error !== null) throw providerFailure(event.response);
      if (event.response.incomplete_details !== undefined && event.response.incomplete_details !== null) fail('RESPONSE_INCOMPLETE', 'completed.incomplete_details_present');
      if (!Array.isArray(event.response.output)) invalid('completed.output_array_required', event);
      const counts = { streamed_count: this.items.size, completed_count: event.response.output.length };
      let finalOutput: unknown[] = event.response.output;
      // Some public streams provide finished native items with an empty terminal aggregate.
      if (finalOutput.length === 0 && this.items.size > 0) {
        finalOutput = [];
        for (let index = 0; index < this.items.size; index++) {
          const state = this.items.get(index);
          if (!state || !state.done) invalid('completed.output_item_gap_or_not_done', { ...counts, output_index: index });
          finalOutput.push(state.done);
        }
      }
      for (const [outputIndex, state] of this.items) {
        if (outputIndex >= finalOutput.length || !state.done || !isDeepStrictEqual(state.done, finalOutput[outputIndex])) invalid('completed.output_item_done_mismatch', { ...counts, output_index: outputIndex });
      }
      const output: ResponseOutputItem[] = [], callIds = new Set<string>(), itemIds = new Set<string>(), events: ClientEvent[] = [];
      let visible = false;
      for (let outputIndex = 0; outputIndex < finalOutput.length; outputIndex++) {
        const item = nativeItem(finalOutput[outputIndex], this.allowedTools);
        if (!identifier(item.id) || itemIds.has(item.id)) invalid('completed.output_item_id_duplicate_or_invalid');
        itemIds.add(item.id);
        if (item.type === 'function_call') {
          if (callIds.has(item.call_id)) fail('INVALID_TOOL_CALL', 'completed.call_id_duplicate');
          callIds.add(item.call_id); visible = true;
        } else if (item.type === 'message') {
          for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
            const part = item.content[contentIndex], full = part.type === 'output_text' ? part.text : part.refusal;
            const text = this.texts.get(`${outputIndex}:${contentIndex}`);
            if (text && (text.text !== full || text.kind !== part.type)) invalid('completed.streamed_text_mismatch');
            if (!text && full !== '') events.push(...this.text(outputIndex, contentIndex, item.id, full, part.type));
            if (full !== '') visible = true;
          }
        }
        output.push(item);
      }
      for (const text of this.texts.values()) {
        const item = output[text.outputIndex];
        if (!item || item.type !== 'message' || !item.content[text.contentIndex]) invalid('completed.streamed_content_not_in_output');
      }
      if (!visible) fail('EMPTY_RESPONSE', 'completed.no_visible_content');
      if (event.response.id !== undefined && !identifier(event.response.id)) invalid('completed.response_id_invalid');
      const response: CompletedResponse = { model: this.model, output };
      if (event.response.id !== undefined) response.id = event.response.id;
      const usage = mapUsage(event.response.usage); if (usage) response.usage = usage;
      this.completed = true; events.push({ type: 'completed', response }); return events;
    } else if (!['response.created', 'response.in_progress', 'response.queued', 'response.content_part.added', 'response.content_part.done',
      'response.output_text.done', 'response.refusal.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done', 'response.output_text.annotation.added'].includes(event.type)) unsupportedEvent(event.type);
    return [];
  }
  end(): void { if (!this.completed) fail('STREAM_INTERRUPTED', 'stream.response_completed_missing'); }
}
