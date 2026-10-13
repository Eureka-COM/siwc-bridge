/**
 * PDF documents for ChatGPT-plan models.
 *
 * DSH decodes only text: `read` reads UTF-8, `web_fetch` returns HTML or text,
 * and attached files reach a model as a path to read. A PDF therefore could not
 * be read at all. The SIWC route accepts PDF input files (`input_file` with
 * `file_url` or `file_data`, including inside a function_call_output), so the
 * `read_pdf` tool records which PDF it read, and the adapter attaches that PDF
 * to the tool result when the conversation is sent. The model reads the document
 * itself; nothing is transcribed or summarised in between.
 *
 * The record is a marker in the tool's own result text. The adapter honours it
 * only in results of `read_pdf`, which only that tool produces; text copied from
 * a web page or a message cannot make the adapter read a local file. Local PDFs
 * are stored in DSH's attachment store (content-addressed, verified on read).
 */

export const PDF_TOOL = 'read_pdf';
/** Largest local PDF the tool stores and attaches (the service limits a request's files). */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** Base64 budget for all PDFs in one request; older ones become a note beyond it. */
export const MAX_REQUEST_DOCUMENT_BASE64 = 32 * 1024 * 1024;

export type DocumentRef =
  | { kind: 'url'; url: string }
  | { kind: 'attachment'; attachmentId: string; bytes: number; name: string };

// The stored name is part of the attachment's address, so it is kept exactly (base64url of UTF-8).
const MARKER = /\[siwc-document (?:url=(https?:\/\/[^\s\]]{1,2048})|attachment=(sha256:[0-9a-f]{64}) bytes=(\d{1,12}) name=([A-Za-z0-9_-]{1,700}))\]/g;

/** ASCII file name for the service; the display name stays in the visible text. */
export function documentFileName(name: string): string {
  const stem = name.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 96);
  return `${stem || 'document'}.pdf`;
}

export function documentMarker(ref: DocumentRef): string {
  return ref.kind === 'url' ? `[siwc-document url=${ref.url}]` : `[siwc-document attachment=${ref.attachmentId} bytes=${ref.bytes} name=${Buffer.from(ref.name, 'utf8').toString('base64url')}]`;
}

export function documentKey(ref: DocumentRef): string { return ref.kind === 'url' ? `url:${ref.url}` : ref.attachmentId; }

/** Markers in one text, and the text without them. */
export function parseDocuments(text: string): { refs: DocumentRef[]; text: string } {
  const refs: DocumentRef[] = [];
  const rest = text.replace(MARKER, (_all, url?: string, attachmentId?: string, bytes?: string, name?: string) => {
    if (url) { const clean = documentUrl(url); if (clean) refs.push({ kind: 'url', url: clean }); }
    else if (attachmentId && bytes && name && Number.isSafeInteger(Number(bytes))) {
      const decoded = Buffer.from(name, 'base64url').toString('utf8');
      if (decoded && decoded.length <= 255 && !/[\\/\u0000-\u001f]/.test(decoded)) refs.push({ kind: 'attachment', attachmentId, bytes: Number(bytes), name: decoded });
    }
    return '';
  });
  return { refs, text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

/** Public http(s) URL without credentials; the service, not this computer, downloads it. */
export function documentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
  const href = url.href;
  return /[\s\]]/.test(href) ? undefined : href;
}

export const isPdf = (data: Uint8Array): boolean => data.byteLength >= 5 && Buffer.from(data.subarray(0, 1024)).includes(Buffer.from('%PDF-'));
