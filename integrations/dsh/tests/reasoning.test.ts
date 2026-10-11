import test from 'node:test';
import assert from 'node:assert/strict';
import { contextForModel, reasoningForModel, reasoningRequest } from '../lib/reasoning.js';

const standard = ['low', 'medium', 'high', 'xhigh', 'max'];
const optional = ['none', ...standard];
const models = new Map([
  ['gpt-6.1-sol', standard], ['gpt-6-astra', standard],
  ['gpt-6-sol', optional], ['gpt-6-luna', optional],
  ['gpt-5.6-sol', optional], ['gpt-5.6-terra', optional], ['gpt-5.6-luna', optional],
]);

test('documented models expose their official effort choices and context size; others expose nothing', () => {
  for (const [model, expected] of models) {
    assert.deepEqual(reasoningForModel(model)!.efforts.map(effort => String(effort.id)), expected);
    assert.deepEqual(contextForModel(model), { contextWindow: 1_050_000 });
  }
  for (const model of ['unknown', 'gpt-6.1-sol-future', 'GPT-6.1-SOL', 'toString', '__proto__']) {
    assert.equal(reasoningForModel(model), undefined); assert.equal(contextForModel(model), undefined);
  }
});

test('effort maps to Responses syntax with a summary; anything not listed falls back to the provider default', () => {
  for (const [model, efforts] of models) {
    assert.deepEqual(reasoningRequest(model, undefined), { summary: 'auto' });
    for (const effort of efforts) assert.deepEqual(reasoningRequest(model, effort), { effort, summary: 'auto' });
  }
  for (const effort of ['none', 'minimal', 'HIGH', '', 1, null, ['high'], { effort: 'high' }]) assert.deepEqual(reasoningRequest('gpt-6.1-sol', effort), { summary: 'auto' });
  assert.equal(reasoningRequest('unknown', 'high'), undefined);
});
