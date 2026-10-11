import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { PlanIndicator } from './plan-indicator.js';

export const name = 'dsh-siwc-bridge-client';
export const inject = ['slots'];

/** Browser part: only the "Using ChatGPT plan · Manage usage" indicator next to the composer. */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'siwc-plan', order: 100 }, PlanIndicator));
}
