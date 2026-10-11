import { ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { BridgeError } from './errors.js';

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

/** Validate explicit controls before transport and map them to public Responses syntax. */
export function reasoningRequest(model: string, effort: unknown): { effort: string } | undefined {
  if (effort === undefined) return undefined;
  const efforts = MODEL_EFFORTS.get(model);
  if (typeof effort !== 'string' || efforts === undefined || !efforts.some(candidate => candidate === effort)) {
    throw new BridgeError('UNSUPPORTED_OPTION', '選択したモデルで対応を確認できない推論の度合いです。モデルと推論設定を選び直してください。');
  }
  return { effort };
}
