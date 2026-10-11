import { ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';

type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const STANDARD_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const OPTIONAL_EFFORTS: readonly Effort[] = ['none', ...STANDARD_EFFORTS];

// Verified against official public model pages on 2026-10-10.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// Exact IDs only: the SIWC catalog does not document per-model effort metadata.
const MODEL_EFFORTS: ReadonlyMap<string, readonly Effort[]> = new Map([
  ['gpt-6.1-sol', STANDARD_EFFORTS],
  ['gpt-6-astra', STANDARD_EFFORTS],
  ['gpt-6-sol', OPTIONAL_EFFORTS],
  ['gpt-6-luna', OPTIONAL_EFFORTS],
  ['gpt-5.6-sol', OPTIONAL_EFFORTS],
  ['gpt-5.6-terra', OPTIONAL_EFFORTS],
  ['gpt-5.6-luna', OPTIONAL_EFFORTS],
]);

const EFFORT_NAMES: Record<Effort, string> = {
  none: 'none（推論なし）', low: 'low（低）', medium: 'medium（中）',
  high: 'high（高）', xhigh: 'xhigh（非常に高い）', max: 'max（最大）',
};

/** Public DSH selector metadata; omission preserves the provider-default choice. */
export function reasoningForModel(model: string): LlmResolvedModelInfo['reasoning'] {
  const efforts = MODEL_EFFORTS.get(model);
  return efforts === undefined ? undefined : {
    efforts: efforts.map(effort => ({ id: ReasoningEffortId(effort), name: EFFORT_NAMES[effort] })),
  };
}

/**
 * Responses `reasoning` for a documented reasoning model: a readable summary is
 * always requested; the chosen effort is added when the model lists it, and an
 * effort it does not list is left to the provider default.
 */
export function reasoningRequest(model: string, effort: unknown): { effort?: string; summary: 'auto' } | undefined {
  const efforts = MODEL_EFFORTS.get(model);
  if (efforts === undefined) return undefined;
  return typeof effort === 'string' && efforts.some(candidate => candidate === effort) ? { effort, summary: 'auto' } : { summary: 'auto' };
}

/**
 * Documented capacity of the exact model IDs above (same official pages, 2026-10-11):
 * 1,050,000-token context window, 128,000 max output, text and image input.
 * DSH uses the context size to compact long sessions before they overflow.
 */
const CONTEXT_WINDOW = 1_050_000;
export function contextForModel(model: string): { contextWindow: number } | undefined {
  return MODEL_EFFORTS.has(model) ? { contextWindow: CONTEXT_WINDOW } : undefined;
}
