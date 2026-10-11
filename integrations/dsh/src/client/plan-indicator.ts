import { createElement } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';

/** SIWC UI guideline: near the composer, "Using ChatGPT plan" with a "Manage usage" link. */
export const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';
export type PlanIndicatorProps = PropsRuntime<'conversation.input.left'>;

/** Shown while this session's model comes from the ChatGPT plan; it never touches the draft or settings. */
export function PlanIndicator({ useProjection }: PlanIndicatorProps) {
  const provider = useProjection('modelSelection', value => value?.next?.provider ?? value?.lastUsed?.provider);
  if (provider !== undefined && provider !== 'siwc') return null;
  return createElement('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', whiteSpace: 'nowrap', opacity: 0.8 },
    title: 'このアプリからのAI要求は、あなたのChatGPTプランの利用枠を使います。',
  }, 'Using ChatGPT plan ·', createElement('a', { href: MANAGE_USAGE, target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit', textDecoration: 'underline' } }, 'Manage usage'));
}
