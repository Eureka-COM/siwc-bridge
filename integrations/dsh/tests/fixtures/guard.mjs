import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const name = 'siwc-test-guard';
export const inject = ['tools', 'agents'];

/** Additional restriction for one disposable dsh scenario; it does not grant permissions. */
export function apply(ctx, config) {
  const dummy = realpathSync(config.dummyPath);
  if (!lstatSync(dummy).isFile() || lstatSync(config.dummyPath).isSymbolicLink()) throw new Error('専用 dummy は通常ファイルである必要があります。');
  for (const key of ['toolLimit', 'maxSteps', 'timeoutMs']) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`guard: ${key} は正の整数が必要です。`);
  const facts = { allowedCalls: [], results: [], denied: 0, timeouts: 0, stoppedSteps: 0 };
  const persist = () => writeFileSync(config.evidencePath, JSON.stringify(facts, null, 2) + '\n', 'utf8');
  const timers = new Map();
  persist();
  const tool = config.tool ?? 'read';
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: [tool] }); });
  ctx.tools.guard(exec => {
    const args = exec.arguments;
    let accepted = exec.name === tool && args && typeof args === 'object' && typeof args.file_path === 'string';
    if (accepted) {
      try { accepted = realpathSync(resolve(args.file_path)) === dummy; } catch { accepted = false; }
    }
    if (!accepted || facts.allowedCalls.length >= config.toolLimit) { facts.denied += 1; persist(); return `SIWC scenario permits only one ${tool} of its dedicated dummy file.`; }
    facts.allowedCalls.push({ callId: exec.callId, name: exec.name }); persist();
    return undefined;
  });
  ctx.on('tools/result', (exec, result) => {
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
    facts.results.push({ callId: exec.callId, name: exec.name, isError: result.isError,
      sha256: createHash('sha256').update(text).digest('hex') }); persist();
  });
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.step > config.maxSteps) { facts.stoppedSteps += 1; persist(); return { kind: 'reject' }; }
    return next();
  });
  ctx.on('agent/status', ({ agent, status }) => {
    const current = timers.get(agent.id); if (current) { clearTimeout(current); timers.delete(agent.id); }
    if (status === 'running') timers.set(agent.id, setTimeout(() => {
      timers.delete(agent.id); facts.timeouts += 1; persist();
      agent.cancel({ kind: 'hook', reason: 'SIWC local scenario deadline' });
    }, config.timeoutMs));
  });
  ctx.effect(() => () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); persist(); });
}
