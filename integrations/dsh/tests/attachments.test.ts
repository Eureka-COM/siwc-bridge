import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SiwcAdapter, requestImageSize, IMAGE_POLICY } from '../lib/adapter.js';
import { buildRequest } from '../lib/protocol.js';

// Synthetic 1x1 PNG bytes only; no real attachment, account or network is used.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ref = (id: string, extra: Record<string, unknown> = {}) => ({ attachmentId: id, mediaType: 'image/png', bytes: PNG.byteLength, width: 4000, height: 3000, name: `${id}.png`, ...extra });
const credentials = { status: async () => ({ activeId: 'registration-a' }), withAccessToken: async (operation: any) => operation('synthetic-test-only', undefined, 'registration-a') };
const completedStream = () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
  { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'red square' }] }] } })}\n\n`,
{ headers: { 'content-type': 'text/event-stream' } });

function attachmentService(versionBytes = PNG.byteLength) {
  const reads: { id: string; target: { width: number; height: number; maxBytes: number } }[] = [];
  return {
    reads,
    service: {
      async readImageRequest(image: any, target: any) {
        reads.push({ id: image.attachmentId, target });
        return { variantId: `v-${image.attachmentId}`, attachment: image, data: PNG, mediaType: 'image/png', bytes: versionBytes, width: target.width, height: target.height, depth: 'uchar', space: 'srgb', hasAlpha: false };
      },
    },
  };
}

async function run(adapter: SiwcAdapter, options: GenerateOptions): Promise<void> { for await (const _ of adapter.stream(options)) { /* drain */ } }

test('user images are sent as native input_image parts with DSH handle text; files never reach the adapter', async () => {
  const original = globalThis.fetch; let body: any; let inference = 0;
  const { reads, service } = attachmentService();
  try {
    globalThis.fetch = async (url, init) => { if (url === 'https://api.openai.com/v1/responses') { inference++; body = JSON.parse(String(init?.body)); } return completedStream(); };
    const adapter = new SiwcAdapter(credentials, {}, { attachments: () => service, imageAccess: () => ({ readonlyPath: 'C:/fixture/attachments/img-a.png' }) });
    await run(adapter, { provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'What colour is this?' }, { type: 'image', attachment: ref('img-a') }] }] } as GenerateOptions);
    assert.equal(inference, 1);
    // DSH's pixel budget is applied before reading the request version.
    assert.deepEqual(reads, [{ id: 'img-a', target: { ...requestImageSize(4000, 3000, IMAGE_POLICY.maxPixels), maxBytes: IMAGE_POLICY.maxBytes } }]);
    const user = body.input.find((item: any) => item.role === 'user');
    assert.ok(Array.isArray(user.content));
    assert.deepEqual(user.content[0], { type: 'input_text', text: 'What colour is this?' });
    assert.equal(user.content[1].type, 'input_text');
    assert.match(user.content[1].text, /img-a|C:\/fixture\/attachments\/img-a\.png/);
    assert.deepEqual(user.content[2], { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, detail: 'auto' });
  } finally { globalThis.fetch = original; }
});

test('tool results with images become a native output array; text-only results stay plain strings', () => {
  const options = {
    provider: 'siwc', model: 'fixture-model', tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'open the screenshot' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }], source: { provider: 'siwc', model: 'fixture-model' } },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'screenshot:' }, { type: 'image', attachment: ref('img-b') }] },
    ],
  } as unknown as GenerateOptions;
  const media = { images: new Map([['img-b', { data: PNG, mediaType: 'image/png', width: 10, height: 10 }]]), handle: () => '[image img-b]' };
  const wire = buildRequest(options, undefined, media);
  const output = (wire.input as any[]).find(item => item.type === 'function_call_output').output;
  assert.deepEqual(output.map((part: any) => part.type), ['input_text', 'input_text', 'input_image']);
  // Without prepared media an image is refused before transport.
  assert.throws(() => buildRequest(options), { code: 'UNSUPPORTED_CONTENT' });
  // Images or files are never accepted in system/developer/assistant history, nor raw files from a caller that skipped DSH's projection.
  assert.throws(() => buildRequest({ provider: 'siwc', model: 'fixture-model', messages: [{ role: 'system', content: [{ type: 'image', attachment: ref('img-c') }] }] } as unknown as GenerateOptions, undefined, media), { code: 'UNSUPPORTED_CONTENT' });
  assert.throws(() => buildRequest({ provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'file', attachment: {} }] }] } as unknown as GenerateOptions, undefined, media), { code: 'UNSUPPORTED_CONTENT' });
  assert.throws(() => buildRequest({ provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'image', attachment: ref('missing') }] }] } as unknown as GenerateOptions, undefined, media), { code: 'UNSUPPORTED_CONTENT' });
});

test('offloaded images are sent as text, oversize requests ask DSH to offload, and a missing attachment service sends nothing', async () => {
  const original = globalThis.fetch; let inference = 0; let body: any;
  try {
    globalThis.fetch = async (url, init) => { if (url === 'https://api.openai.com/v1/responses') { inference++; body = JSON.parse(String(init?.body)); } return completedStream(); };
    const offloaded = { provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'earlier' }, { type: 'image', attachment: ref('img-old'), offloaded: true }] }] } as unknown as GenerateOptions;
    const { reads, service } = attachmentService();
    await run(new SiwcAdapter(credentials, {}, { attachments: () => service }), offloaded);
    assert.equal(inference, 1); assert.equal(reads.length, 0);
    const user = body.input.find((item: any) => item.role === 'user');
    assert.equal(typeof user.content, 'string'); assert.match(user.content, /earlier/);

    // 16 images of ~1.5 MiB base64 each exceed the 20 MiB request budget: DSH offloads, no request is sent.
    const big = attachmentService(1_200_000);
    const many = { provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: Array.from({ length: 16 }, (_, i) => ({ type: 'image', attachment: ref(`img-${i}`) })) }] } as unknown as GenerateOptions;
    await assert.rejects(run(new SiwcAdapter(credentials, {}, { attachments: () => big.service }), many), (error: any) => error.code === IMAGE_OFFLOAD_REQUIRED_CODE && error.failure?.offloadImages > 0);
    assert.equal(inference, 1);

    const image = { provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'image', attachment: ref('img-x') }] }] } as unknown as GenerateOptions;
    await assert.rejects(run(new SiwcAdapter(credentials), image), (error: any) => error.providerCode === 'UNSUPPORTED_CONTENT');
    assert.equal(inference, 1);
  } finally { globalThis.fetch = original; }
});

test('the account catalog advertises image input so DSH does not reduce images to text', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
    const models = await new SiwcAdapter(credentials).listModelsFresh('siwc');
    assert.deepEqual(models[0].inputModalities, ['text', 'image']);
  } finally { globalThis.fetch = original; }
});
