export class BridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number, public readonly requestId?: string) {
    super(message); this.name = 'BridgeError';
  }
}
const safeDiagnostics = new WeakMap<Error, string>();
/** Internal only: callers supply messages made locally, never provider exception text. */
export function rememberFailure<T extends Error>(error: T, diagnostic: string): T { safeDiagnostics.set(error, diagnostic); return error; }
export function safeFailure(error: unknown): string {
  if (error instanceof Error && safeDiagnostics.has(error)) return safeDiagnostics.get(error)!;
  if (error instanceof BridgeError) return `${error.code}: ${error.message}${error.status ? ` (HTTP ${error.status})` : ''}${error.requestId ? ` [request_id=${error.requestId}]` : ''}`;
  if (error instanceof DOMException && error.name === 'AbortError') return 'CANCELLED: 中断しました。';
  return 'INTERNAL_ERROR: 処理に失敗しました。秘密を含む診断内容は表示しません。';
}
