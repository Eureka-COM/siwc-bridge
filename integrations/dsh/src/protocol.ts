import type { GenerateOptions, RequestMessage, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from './errors.js';
import { reasoningRequest } from './reasoning.js';

/**
 * DSH ↔ Responses translation for the ChatGPT-plan route (SIWC).
 *
 * Design rule: be strict only where a mistake would act on the user's behalf
 * (a tool call is released only after the whole response completed) or leak
 * data (provider text is never echoed into diagnostics). Everything else is
 * tolerant: unknown events are skipped, history that cannot be replayed
 * natively is resent as plain history, and options the route does not support
 * are left out instead of failing the turn. Each such decision is recorded as
 * a machine label in `Notes` for the local diagnostics log.
 */

export const TOOL_NAMESPACE = 'dsh';
const MAX_EVENT = 4 * 1024 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === 'string';
/** Only plain machine labels ever reach messages or logs; provider text can reflect submitted secrets. */
export const label = (value: unknown, maximum = 120): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_.:\-[\]]+$/.test(value) ? value : undefined;

/** Machine labels describing what was skipped or adjusted; written to the diagnostics log only. */
export class Notes {
  private readonly rows = new Map<string, number>();
  add(name: string): void { const key = label(name, 160) ?? 'redacted'; this.rows.set(key, (this.rows.get(key) ?? 0) + 1); }
  get size(): number { return this.rows.size; }
  list(): string[] { return [...this.rows].map(([name, count]) => count > 1 ? `${name}x${count}` : name); }
}

export class ProviderFailure extends BridgeError {
  constructor(code: string, message: string, status?: number, requestId?: string,
    public readonly param?: string, public readonly responseShape = 'other') {
    super(code, message, status, requestId);
  }
}

const MESSAGES: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: 'ChatGPTプランの利用上限に達しました。ChatGPTの設定 → Usage（Manage usage）で、プランまたはこのアプリの上限を確認してください。',
  subscription_sharing_usage_unavailable: 'ChatGPTの利用枠を確認できませんでした。しばらくしてから再実行してください。',
  subscription_sharing_user_unavailable: 'ChatGPTのアカウント情報を一時的に確認できません。しばらくしてから再実行してください。',
  subscription_sharing_user_not_eligible: 'このアカウントまたはworkspaceでは、ChatGPTプランをこのアプリで使えません。',
  subscription_sharing_unsupported_capability: 'ChatGPTプラン経由では使えない機能が要求に含まれていました。',
  subscription_sharing_route_not_supported: 'この接続方法はChatGPTプラン経由では使えません。',
  subscription_sharing_invalid_user: 'サインイン情報を確認できませんでした。/siwc status で状態を確認してください。',
  context_length_exceeded: '会話がモデルの上限を超えました。',
};

/** Classify an error body by its codes only; provider prose is never kept. */
export function providerFailure(body: unknown, status?: number, requestId?: unknown): ProviderFailure {
  const root = object(body) ? body : {};
  const detail = object(root.error) ? root.error : root;
  const code = label(typeof root.error === 'string' ? root.error : detail.code, 100) ?? label(detail.type, 100)
    ?? (status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limit' : status !== undefined && status >= 500 ? 'service_unavailable' : 'provider_error');
  const param = label(detail.param);
  const id = label(requestId ?? root.request_id, 160);
  const shape = object(root.error) ? 'structured_error' : typeof root.error === 'string' ? 'oauth_error' : typeof root.detail === 'string' ? 'detail' : 'other';
  return new ProviderFailure(code, MESSAGES[code] ?? 'ChatGPTプランへの要求が拒否されました（内容は安全のため表示しません）。', status, id, param, shape);
}

/** Encoded request version of one attached image, prepared by the adapter from DSH's attachment service. */
export interface RequestImage { data: Uint8Array; mediaType: string; width: number; height: number }
/** Images ready to send, plus the model-facing handle text DSH uses for every image occurrence. */
export interface RequestMedia {
  images: ReadonlyMap<string, RequestImage>;
  handle: (ref: ImageAttachmentRef, version: RequestImage) => string;
}
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface BuildContext { registrationId?: string; media?: RequestMedia; notes?: Notes }

/** User and tool content: text, plus images as native input parts. */
function content(message: RequestMessage, context: BuildContext): string | Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === 'text') { if (block.text !== '') parts.push({ type: 'input_text', text: block.text }); continue; }
    if (block.type === 'image') {
      const version = context.media?.images.get(block.attachment.attachmentId);
      if (version && IMAGE_TYPES.has(version.mediaType) && version.data instanceof Uint8Array && version.data.byteLength > 0 && context.media) {
        parts.push({ type: 'input_text', text: context.media.handle(block.attachment, version) });
        parts.push({ type: 'input_image', image_url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`, detail: 'auto' });
      } else {
        context.notes?.add('request.image_unavailable');
        parts.push({ type: 'input_text', text: `[An attached image${block.attachment?.name ? ` "${block.attachment.name}"` : ''} could not be loaded for this request.]` });
      }
      continue;
    }
    if (block.type === 'file') {
      // DSH projects files to their read-only path before the adapter; keep a visible trace if one arrives anyway.
      context.notes?.add('request.file_block');
      parts.push({ type: 'input_text', text: `[An attached file${block.attachment?.name ? ` "${block.attachment.name}"` : ''} is available to read with the file tools.]` });
      continue;
    }
    context.notes?.add(`request.skipped_block.${label(block.type, 40) ?? 'unknown'}`);
  }
  if (parts.every(part => part.type === 'input_text')) return parts.map(part => String(part.text)).join('\n');
  return parts;
}

function plainText(message: RequestMessage, context: BuildContext): string {
  return message.content.flatMap(block => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'tool-addition' || block.type === 'tool-removal' || block.type === 'reasoning') return [];
    context.notes?.add(`request.skipped_block.${label(block.type, 40) ?? 'unknown'}`);
    return [];
  }).join('\n');
}

/** The visible text/tool-call blocks a stored reply is validated against before its native items are reused. */
export function visibleOf(blocks: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return blocks.flatMap((block): Record<string, unknown>[] => block.type === 'text' ? (block.text === '' ? [] : [{ type: 'text', text: block.text }])
    : block.type === 'tool-call' ? [{ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }] : []);
}

const REPLAY_TYPES = new Set(['message', 'reasoning', 'function_call']);
/** Native items of a stored reply, or undefined when they must not be reused (other account, other model, edited history). */
function nativeReplay(message: RequestMessage & { role: 'assistant' }, options: GenerateOptions, context: BuildContext): Record<string, unknown>[] | undefined {
  const state = message.source.replayState;
  if (state === undefined) return undefined;
  const response = object(state) && object(state.response) ? state.response : undefined;
  if (!response || response.kind !== 'siwc-responses' || !Array.isArray(response.output)) { context.notes?.add('replay.unknown_format'); return undefined; }
  if (response.version !== 2 || context.registrationId === undefined || response.registrationId !== context.registrationId) { context.notes?.add('replay.other_registration'); return undefined; }
  if (response.model !== options.model) { context.notes?.add('replay.other_model'); return undefined; }
  if (!Array.isArray(response.visible) || !isDeepStrictEqual(response.visible, visibleOf(message.content as unknown as Record<string, unknown>[]))) { context.notes?.add('replay.content_changed'); return undefined; }
  return response.output.filter((item): item is Record<string, unknown> => object(item) && REPLAY_TYPES.has(String(item.type))).map(item => structuredClone(item));
}

/** Options the ChatGPT-plan route rejects; they are left out rather than failing the turn. */
const UNSUPPORTED_OPTIONS = ['temperature', 'maxTokens', 'stop', 'topP', 'top_p', 'presencePenalty', 'frequencyPenalty', 'seed'];

/** Build one Responses request. History shape never fails a turn; only a missing model or history stops before transport. */
export function buildRequest(options: GenerateOptions, context: BuildContext = {}): Record<string, unknown> {
  if (typeof options.model !== 'string' || options.model.length === 0 || !Array.isArray(options.messages)) throw new BridgeError('INVALID_REQUEST', 'モデルと会話履歴を指定してください。');
  for (const key of UNSUPPORTED_OPTIONS) if ((options as unknown as Record<string, unknown>)[key] !== undefined) context.notes?.add(`request.option_omitted.${key}`);
  const reasoning = reasoningRequest(options.model, options.reasoningEffort);
  if (options.reasoningEffort !== undefined && !reasoning?.effort) context.notes?.add('request.reasoning_effort_omitted');
  const input: Record<string, unknown>[] = [];
  if (options.system !== undefined && options.system !== '') input.push({ role: 'developer', content: options.system });
  const pending = new Set<string>(); const answered = new Set<string>(); const known = new Set<string>();
  // Every function_call needs exactly one output before the conversation moves on;
  // a call left open (cancelled turn, compaction) gets an explicit placeholder result.
  const closeOpenCalls = () => {
    for (const id of pending) { input.push({ type: 'function_call_output', call_id: id, output: '[No result: this tool call did not complete.]' }); answered.add(id); context.notes?.add('request.open_call_closed'); }
    pending.clear();
  };
  const addCall = (id: string, name: string, args: string, item?: Record<string, unknown>) => {
    if (known.has(id)) { context.notes?.add('request.duplicate_call_skipped'); return; }
    known.add(id); pending.add(id);
    input.push(item ?? { type: 'function_call', namespace: TOOL_NAMESPACE, call_id: id, name, arguments: args === '' ? '{}' : args });
  };
  for (const message of options.messages) {
    if (message.role === 'tool') {
      const output = content(message, context);
      if (pending.has(message.toolCallId)) {
        pending.delete(message.toolCallId); answered.add(message.toolCallId);
        input.push({ type: 'function_call_output', call_id: message.toolCallId, output });
      } else {
        // A result without its call (or a second result) is kept as context, not dropped.
        context.notes?.add(answered.has(message.toolCallId) ? 'request.duplicate_tool_result' : 'request.orphan_tool_result');
        const body = typeof output === 'string' ? output : output.filter(part => part.type === 'input_text').map(part => String(part.text)).join('\n');
        if (body !== '') input.push({ role: 'user', content: `[Earlier tool result]\n${body}` });
      }
      continue;
    }
    closeOpenCalls();
    if (message.role === 'assistant') {
      const native = nativeReplay(message, options, context);
      if (native) {
        for (const item of native) {
          if (item.type === 'function_call' && text(item.call_id)) addCall(item.call_id, String(item.name), String(item.arguments ?? ''), item);
          else input.push(item);
        }
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'text') { if (block.text !== '') input.push({ role: 'assistant', content: block.text }); }
        else if (block.type === 'tool-call') addCall(block.id, block.name, block.arguments);
        else if (block.type !== 'reasoning') context.notes?.add(`request.skipped_block.${label(block.type, 40) ?? 'unknown'}`);
      }
      continue;
    }
    if (message.role === 'user') {
      const value = content(message, context);
      if (value !== '' && !(Array.isArray(value) && value.length === 0)) input.push({ role: 'user', content: value });
      continue;
    }
    // system and developer: the route rejects role "system" items.
    const value = plainText(message, context);
    if (value !== '') input.push({ role: 'developer', content: value });
  }
  closeOpenCalls();
  const body: Record<string, unknown> = { model: options.model, input, store: false, stream: true };
  if (reasoning) body.reasoning = reasoning;
  // Opaque reasoning is needed to continue a reasoning model's work with store:false.
  body.include = ['reasoning.encrypted_content'];
  if (options.tools?.length) {
    const names = new Set<string>();
    const tools = options.tools.flatMap(tool => {
      if (names.has(tool.name)) { context.notes?.add('request.duplicate_tool_skipped'); return []; }
      names.add(tool.name);
      return [{ type: 'function', name: tool.name, description: tool.description ?? '', parameters: object(tool.parameters) ? tool.parameters : { type: 'object', properties: {} }, strict: false }];
    });
    body.tools = [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed by the local DeepSeek Harness with its own approval policy.', tools }];
  }
  return body;
}

/** SSE framing; tolerant of unknown fields and comments, bounded in size. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal, notes?: Notes): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let pending = '', total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  const parse = (frame: string): Record<string, unknown> | undefined => {
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    if (!data.length) return undefined;
    const value = data.join('\n');
    if (value === '[DONE]') return undefined;
    let event: unknown;
    try { event = JSON.parse(value); } catch { notes?.add('sse.unparsable_frame'); return undefined; }
    if (!object(event) || typeof event.type !== 'string') { notes?.add('sse.untyped_frame'); return undefined; }
    return event;
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) { pending += decoder.decode(); break; }
      total += value.byteLength;
      if (total > MAX_RESPONSE) throw new BridgeError('RESPONSE_TOO_LARGE', 'ChatGPTの応答が大きすぎるため中断しました。');
      pending += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (frame.length > MAX_EVENT) throw new BridgeError('RESPONSE_TOO_LARGE', 'ChatGPTの応答イベントが大きすぎるため中断しました。');
        const event = parse(frame); if (event) yield event;
      }
      if (pending.length > MAX_EVENT) throw new BridgeError('RESPONSE_TOO_LARGE', 'ChatGPTの応答イベントが大きすぎるため中断しました。');
    }
    if (pending.trim() !== '') { const event = parse(pending); if (event) yield event; }
  } catch (error) {
    if (signal?.aborted) throw new BridgeError('CANCELLED', '中断しました。');
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('STREAM_INTERRUPTED', 'ChatGPTからの応答が途中で途切れました。');
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function mapUsage(value: unknown): TokenUsage | undefined {
  if (!object(value) || !integer(value.input_tokens) || !integer(value.output_tokens)) return undefined;
  const inputDetails = object(value.input_tokens_details) ? value.input_tokens_details : {};
  const cached = integer(inputDetails.cached_tokens) ? inputDetails.cached_tokens : undefined;
  const written = integer(inputDetails.cache_write_tokens) ? inputDetails.cache_write_tokens : undefined;
  const cacheRead = cached ?? 0, cacheWrite = written ?? 0;
  if (cacheRead + cacheWrite > value.input_tokens) return { inputTokens: value.input_tokens, outputTokens: value.output_tokens };
  const usage: TokenUsage = { inputTokens: value.input_tokens - cacheRead - cacheWrite, outputTokens: value.output_tokens };
  if (cached !== undefined) usage.cacheReadTokens = cacheRead;
  if (written !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (integer(value.total_tokens)) usage.totalTokens = value.total_tokens;
  const outputDetails = object(value.output_tokens_details) ? value.output_tokens_details : {};
  if (integer(outputDetails.reasoning_tokens) && outputDetails.reasoning_tokens <= value.output_tokens) usage.reasoningTokens = outputDetails.reasoning_tokens;
  return usage;
}

interface Block { index: number; text: string; closed: boolean }
interface Item { added: Record<string, unknown>; done?: Record<string, unknown>; args: string }

const IGNORED_EVENTS = new Set(['response.created', 'response.in_progress', 'response.queued', 'response.content_part.added', 'response.content_part.done',
  'response.output_text.done', 'response.refusal.done', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done', 'response.function_call_arguments.done', 'response.output_text.annotation.added']);

/**
 * Turn Responses events into DSH stream chunks.
 * - Text and reasoning summaries stream live.
 * - Tool calls are released only from a completed response, never from partial events.
 * - Events this adapter does not use are skipped (and noted), so new service
 *   events never fail a turn. Success still requires response.completed.
 */
export class ResponseStream {
  private readonly items = new Map<number, Item>();
  private readonly texts = new Map<string, Block>();
  private readonly summaries = new Map<string, Block>();
  private nextIndex = 0;
  completed = false;
  constructor(private readonly model: string, private readonly notes = new Notes(), private readonly registrationId?: string) {}

  private append(map: Map<string, Block>, key: string, kind: 'text' | 'reasoning', delta: string): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    let block = map.get(key);
    if (!block) { block = { index: this.nextIndex++, text: '', closed: false }; map.set(key, block); chunks.push({ type: 'block-start', index: block.index, blockType: kind }); }
    if (block.closed) { this.notes.add(`stream.${kind}_after_close`); return chunks; }
    block.text += delta;
    if (block.text.length > MAX_RESPONSE) throw new BridgeError('RESPONSE_TOO_LARGE', 'ChatGPTの応答が大きすぎるため中断しました。');
    if (delta !== '') chunks.push(kind === 'text' ? { type: 'text-delta', index: block.index, text: delta } : { type: 'reasoning-delta', index: block.index, text: delta });
    return chunks;
  }

  accept(event: Record<string, unknown>): StreamChunk[] {
    if (this.completed) { this.notes.add('stream.event_after_completion'); return []; }
    const type = String(event.type);
    switch (type) {
      case 'error': throw providerFailure(event);
      case 'response.failed': throw providerFailure(object(event.response) ? event.response : event);
      case 'response.incomplete': return this.incomplete(event);
      case 'response.completed': return this.complete(event);
      case 'response.output_item.added':
        if (integer(event.output_index) && object(event.item)) this.items.set(event.output_index, { added: structuredClone(event.item), args: '' });
        return [];
      case 'response.output_item.done':
        if (integer(event.output_index) && object(event.item)) {
          const item = this.items.get(event.output_index) ?? { added: structuredClone(event.item), args: '' };
          item.done = structuredClone(event.item); this.items.set(event.output_index, item);
        }
        return [];
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        return text(event.delta) ? this.append(this.texts, `${event.output_index}:${event.content_index ?? 0}`, 'text', event.delta) : [];
      case 'response.reasoning_summary_text.delta':
        return text(event.delta) ? this.append(this.summaries, `${event.output_index}`, 'reasoning', event.delta) : [];
      case 'response.reasoning_summary_part.added': {
        // Later summary parts continue the same reasoning block as a new paragraph.
        const block = this.summaries.get(`${event.output_index}`);
        return block && block.text !== '' && !block.closed ? this.append(this.summaries, `${event.output_index}`, 'reasoning', '\n\n') : [];
      }
      case 'response.function_call_arguments.delta': {
        const item = integer(event.output_index) ? this.items.get(event.output_index) : undefined;
        if (item && text(event.delta)) item.args += event.delta;
        return [];
      }
      default:
        if (!IGNORED_EVENTS.has(type)) this.notes.add(`stream.skipped_event.${label(type) ?? 'redacted'}`);
        return [];
    }
  }

  private closeAll(chunks: StreamChunk[]): void {
    const blocks = [...[...this.summaries.values()].map(block => ({ block, kind: 'reasoning' as const })), ...[...this.texts.values()].map(block => ({ block, kind: 'text' as const }))]
      .sort((a, b) => a.block.index - b.block.index);
    for (const { block, kind } of blocks) {
      if (block.closed) continue;
      block.closed = true;
      chunks.push({ type: 'block-end', index: block.index, block: kind === 'text' ? { type: 'text', text: block.text } : { type: 'reasoning', text: block.text } });
    }
  }

  private incomplete(event: Record<string, unknown>): StreamChunk[] {
    const response = object(event.response) ? event.response : {};
    const reason = object(response.incomplete_details) ? label(response.incomplete_details.reason, 60) : undefined;
    this.notes.add(`stream.incomplete.${reason ?? 'unknown'}`);
    if (reason !== 'max_output_tokens' || ![...this.texts.values()].some(block => block.text !== '')) {
      throw new BridgeError(reason === 'content_filter' ? 'CONTENT_FILTERED' : 'RESPONSE_INCOMPLETE',
        reason === 'content_filter' ? 'ChatGPTの安全上の判断で応答が途中で止まりました。' : `ChatGPTの応答が完了しませんでした（${reason ?? 'unknown'}）。`);
    }
    // A long answer that reached the output cap is kept; tool calls from it are never run.
    const chunks: StreamChunk[] = [];
    this.closeAll(chunks);
    const usage = mapUsage(response.usage); if (usage) chunks.push({ type: 'usage', usage });
    this.completed = true;
    chunks.push({ type: 'finish', reason: { kind: 'max-tokens' } });
    return chunks;
  }

  private complete(event: Record<string, unknown>): StreamChunk[] {
    const response = object(event.response) ? event.response : {};
    if (response.error !== undefined && response.error !== null) throw providerFailure(response);
    const reported = Array.isArray(response.output) ? response.output.filter(object) : [];
    // The final response is authoritative; when it is empty, finished stream items are used.
    const output: Record<string, unknown>[] = reported.length > 0 ? reported.map(item => structuredClone(item))
      : [...this.items.entries()].sort(([a], [b]) => a - b).flatMap(([, item]) => item.done ? [item.done] : []);
    // The ChatGPT-plan route normally sends an empty final output; the finished items are the answer.
    const chunks: StreamChunk[] = [];
    const calls: { id: string; name: string; arguments: string }[] = [];
    const seen = new Set<string>();
    for (const [outputIndex, item] of output.entries()) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const [contentIndex, part] of item.content.entries()) {
          if (!object(part)) continue;
          const full = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
          if (!text(full)) continue;
          const key = `${outputIndex}:${contentIndex}`;
          const streamed = this.texts.get(key);
          if (!streamed) { if (full !== '') chunks.push(...this.append(this.texts, key, 'text', full)); }
          // What the user already saw stays; a differing final text is only noted.
          else if (streamed.text !== full) this.notes.add('stream.final_text_differs');
        }
      } else if (item.type === 'function_call') {
        const id = text(item.call_id) && item.call_id !== '' ? item.call_id : undefined;
        const name = text(item.name) && item.name !== '' ? item.name : undefined;
        if (!id || !name) { this.notes.add('stream.call_without_id_or_name'); continue; }
        if (seen.has(id)) { this.notes.add('stream.duplicate_call'); continue; }
        seen.add(id);
        const streamedArgs = [...this.items.values()].find(entry => entry.added.call_id === id)?.args;
        const args = text(item.arguments) ? item.arguments : streamedArgs ?? '';
        calls.push({ id, name, arguments: args === '' ? '{}' : args });
      } else if (item.type === 'reasoning') {
        // Summaries normally stream; when they did not, show the final summary once.
        if (!this.summaries.has(`${outputIndex}`) && Array.isArray(item.summary)) {
          const summary = item.summary.flatMap(part => object(part) && text(part.text) ? [part.text] : []).join('\n\n');
          if (summary !== '') chunks.push(...this.append(this.summaries, `${outputIndex}`, 'reasoning', summary));
        }
      } else this.notes.add(`stream.skipped_item.${label(item.type, 40) ?? 'unknown'}`);
    }
    this.closeAll(chunks);
    for (const call of calls) {
      const index = this.nextIndex++;
      chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
      chunks.push({ type: 'tool-call-delta', index, id: call.id as ToolCallId, name: call.name, argumentsDelta: call.arguments });
      chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: call.id as ToolCallId, name: call.name, arguments: call.arguments } });
    }
    if (![...this.texts.values()].some(block => block.text !== '') && calls.length === 0) throw new BridgeError('EMPTY_RESPONSE', 'ChatGPTから空の応答が返りました。');
    const usage = mapUsage(response.usage); if (usage) chunks.push({ type: 'usage', usage });
    this.completed = true;
    const ordered = [...this.texts.values()].map(block => ({ index: block.index, block: { type: 'text', text: block.text } as Record<string, unknown> }))
      .concat(calls.map((call, offset) => ({ index: this.nextIndex - calls.length + offset, block: { type: 'tool-call', ...call } })))
      .sort((a, b) => a.index - b.index).map(entry => entry.block);
    chunks.push({ type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' }, replayState: { response: {
      kind: 'siwc-responses', version: this.registrationId === undefined ? 1 : 2,
      ...(this.registrationId === undefined ? {} : { registrationId: this.registrationId }),
      model: this.model, output: output.filter(item => REPLAY_TYPES.has(String(item.type))), visible: visibleOf(ordered) } } });
    return chunks;
  }

  end(): void { if (!this.completed) throw new BridgeError('STREAM_INTERRUPTED', 'ChatGPTからの応答が完了前に途切れました。'); }
}
