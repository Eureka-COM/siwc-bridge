/** Public Responses items. Provider fields on completed native items are preserved. */
export interface InputMessage extends Record<string, unknown> {
  type?: 'message';
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string | readonly { type: 'input_text'; text: string }[];
}
export interface OutputMessage extends Record<string, unknown> {
  type: 'message'; id: string; role: 'assistant'; status: 'completed';
  content: readonly ({ type: 'output_text'; text: string; annotations?: readonly unknown[] } | { type: 'refusal'; refusal: string })[];
}
export interface ReasoningItem extends Record<string, unknown> {
  type: 'reasoning'; id: string; status?: 'completed';
  summary: readonly { type: 'summary_text'; text: string }[];
  encrypted_content?: string | null;
}
export interface FunctionCallItem extends Record<string, unknown> {
  type: 'function_call'; id?: string; namespace: string; call_id: string;
  name: string; arguments: string; status?: 'completed';
}
export interface FunctionCallOutputItem extends Record<string, unknown> {
  type: 'function_call_output'; call_id: string; output: string;
}
export type ResponseOutputItem = OutputMessage | ReasoningItem | FunctionCallItem;
export type ResponseInputItem = InputMessage | ResponseOutputItem | FunctionCallOutputItem;
export interface FunctionTool {
  type: 'function'; name: string; description?: string;
  parameters: Record<string, unknown>; strict?: boolean;
}
export interface NamespaceTool {
  type: 'namespace'; name: string; description?: string;
  tools: readonly FunctionTool[];
}
export interface ResponseRequest {
  model: string; input: readonly ResponseInputItem[];
  tools?: readonly NamespaceTool[]; instructions?: string; signal?: AbortSignal;
}
export interface ModelInfo { id: string; name: string; }
/** Observed token counters; these do not establish subscription accounting. */
export interface TokenUsage {
  inputTokens: number; outputTokens: number; totalTokens?: number;
  cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
}
export interface CompletedResponse {
  model: string; output: ResponseOutputItem[]; usage?: TokenUsage; id?: string;
}
/** Function calls are available only inside an entirely validated completed response. */
export type ClientEvent = { type: 'text.delta'; text: string } | { type: 'completed'; response: CompletedResponse };
