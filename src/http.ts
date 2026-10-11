import { BridgeError } from './errors.js';

export const MAX_JSON_BYTES = 1024 * 1024;
/** Bound retained UTF-8 bytes while consuming; never accept a truncated JSON prefix. */
export async function readText(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) { signal?.throwIfAborted(); return ''; }
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let total = 0, complete = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_JSON_BYTES) {
      throw new BridgeError('RESPONSE_TOO_LARGE', 'SIWCのJSON応答が受信上限を超えました。本文は表示しません。');
    }
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) throw new BridgeError('RESPONSE_TOO_LARGE', 'SIWCのJSON応答が受信上限を超えました。本文は表示しません。');
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
