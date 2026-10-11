import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningForModel, reasoningRequest } from '../lib/reasoning.js';
import { BridgeError } from '../lib/errors.js';

const standard = ['low', 'medium', 'high', 'xhigh', 'max'];
const optional = ['none', ...standard];
const models = new Map([
  ['gpt-6.1-sol', standard], ['gpt-6-astra', standard],
  ['gpt-6-sol', optional], ['gpt-6-luna', optional],
  ['gpt-5.6-sol', optional], ['gpt-5.6-terra', optional], ['gpt-5.6-luna', optional],
]);

test('確認済み7モデルだけが公開仕様の推論候補を持ち、provider defaultを保持する', () => {
  for (const [model, expected] of models) {
    const metadata = reasoningForModel(model);
    assert.ok(metadata);
    assert.deepEqual(metadata.efforts.map(effort => String(effort.id)), expected);
    assert.equal(Object.hasOwn(metadata, 'defaultEffort'), false);
    assert.ok(metadata.efforts.every(effort => effort.name.length > 0));
  }
  for (const model of ['unknown', 'gpt-5.5', 'gpt-6.1-sol-future', 'GPT-6.1-SOL', 'toString', '__proto__']) {
    assert.equal(reasoningForModel(model), undefined);
  }
});

test('推論メタデータの利用側の編集が後続の候補や検証に影響しない', () => {
  const metadata = reasoningForModel('gpt-6.1-sol')!;
  metadata.efforts[0]!.name = 'changed';
  assert.notEqual(reasoningForModel('gpt-6.1-sol')!.efforts[0]!.name, 'changed');
  assert.deepEqual(reasoningRequest('gpt-6.1-sol', 'low'), { effort: 'low' });
});

test('明示設定をResponses形式へ変換し、未指定とnoneを区別する', () => {
  for (const [model, efforts] of models) {
    assert.equal(reasoningRequest(model, undefined), undefined);
    for (const effort of efforts) assert.deepEqual(reasoningRequest(model, effort), { effort });
  }
  assert.equal(reasoningRequest('unknown', undefined), undefined);
  assert.deepEqual(reasoningRequest('gpt-6-sol', 'none'), { effort: 'none' });
});

test('未知モデル・未対応値・不正型を静的な診断で送信前に拒否する', () => {
  const cases: [string, unknown][] = [
    ['unknown', 'high'], ['toString', 'high'], ['gpt-6.1-sol-future', 'high'],
    ['gpt-6.1-sol', 'none'], ['gpt-6-astra', 'none'],
    ['gpt-6-sol', 'minimal'], ['gpt-6-sol', 'ultra'], ['gpt-6-sol', 'HIGH'],
    ['gpt-6-sol', ''], ['gpt-6-sol', 'FAKE_SECRET_VALUE'],
    ['gpt-6-sol', 1], ['gpt-6-sol', null], ['gpt-6-sol', true],
    ['gpt-6-sol', ['high']], ['gpt-6-sol', { effort: 'high' }],
  ];
  let message: string | undefined;
  for (const [model, effort] of cases) {
    assert.throws(() => reasoningRequest(model, effort), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'UNSUPPORTED_OPTION');
      message ??= error.message;
      assert.equal(error.message, message);
      assert.equal(error.message.includes('FAKE_SECRET_VALUE'), false);
      return true;
    });
  }
});
