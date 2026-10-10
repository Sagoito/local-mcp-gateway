import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultStore } from '../src/results.js';

test('joins text blocks, parses JSON, and falls back to structured content only when content is absent', () => {
  const store = new ResultStore();
  assert.equal(store.present({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }), 'hello\nworld');
  assert.deepEqual(store.present({ content: [{ type: 'text', text: '{"answer":42}' }] }), { answer: 42 });
  assert.deepEqual(store.present({ content: [], structuredContent: { ok: true } }), { ok: true });
  assert.equal(store.present({ content: [{ type: 'text', text: 'plain' }], structuredContent: { ignored: true } }), 'plain');
});

test('retains oversized raw results and returns bounded metadata with a fetch hint', async () => {
  let sequence = 0;
  const store = new ResultStore({ inlineBytes: 32, id: () => `result-${++sequence}` });
  const raw = { content: [{ type: 'text', text: JSON.stringify({ incidents: Array.from({ length: 18 }, (_, id) => ({ id, title: 'x'.repeat(20) })) }) }] };
  const metadata = store.present(raw) as { gatewayResult: { id: string; bytes: number; shape: { properties: Record<string, { length?: number; itemKeys?: string[] }> } }; hint: string };
  assert.equal(metadata.gatewayResult.id, 'result-1');
  assert.ok(metadata.gatewayResult.bytes > 32);
  assert.equal(metadata.gatewayResult.shape.properties.incidents.length, 18);
  assert.deepEqual(metadata.gatewayResult.shape.properties.incidents.itemKeys, ['id', 'title']);
  assert.match(metadata.hint, /execute\.result/);
  assert.match(metadata.hint, /custom processing/);
  assert.match(metadata.hint, /mcp\.text\(await mcp\.result\("result-1"\)\)/);
  assert.doesNotMatch(metadata.hint, /mcp\.json\(await mcp\.result/);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= 4096);
  assert.deepEqual(await store.get('result-1'), raw);
});

test('evicts least recently used entries at the entry and byte limits', async () => {
  let sequence = 0;
  const store = new ResultStore({ inlineBytes: 0, maxEntries: 2, maxTotalBytes: 500, id: () => `id-${++sequence}` });
  const large = (word: string) => ({ content: [{ type: 'text', text: JSON.stringify({ value: word.repeat(60) }) }] });
  store.present(large('a'));
  store.present(large('b'));
  await store.get('id-1'); // Access refreshes its recency.
  store.present(large('c'));
  await assert.rejects(store.get('id-2'), /Unknown or expired/);
  assert.deepEqual(await store.get('id-1'), large('a'));
  assert.deepEqual(await store.get('id-3'), large('c'));

  const byteLimited = new ResultStore({ inlineBytes: 0, maxEntries: 8, maxTotalBytes: 220, id: () => `byte-${++sequence}` });
  byteLimited.present(large('d'));
  byteLimited.present(large('e'));
  await assert.rejects(byteLimited.get('byte-4'), /Unknown or expired/);
  await assert.doesNotReject(byteLimited.get('byte-5'));
});

test('expires results by injected clock and clear removes every snapshot', async () => {
  let now = 100;
  let sequence = 0;
  const store = new ResultStore({ inlineBytes: 0, ttlMs: 50, now: () => now, id: () => `ttl-${++sequence}` });
  store.present({ content: [{ type: 'text', text: 'large enough' }] });
  now = 149;
  assert.deepEqual(await store.get('ttl-1'), { content: [{ type: 'text', text: 'large enough' }] });
  now = 150;
  await assert.rejects(store.get('ttl-1'), /Unknown or expired/);
  store.present({ content: [{ type: 'text', text: 'also large' }] });
  store.clear();
  await assert.rejects(store.get('ttl-2'), /Unknown or expired/);
});

test('snapshots are immutable and non-text content is preserved raw', async () => {
  let sequence = 0;
  const store = new ResultStore({ inlineBytes: 1, id: () => `snap-${++sequence}` });
  const raw = { content: [{ type: 'image', data: 'original', mimeType: 'image/png' }], structuredContent: { hidden: true } };
  store.present(raw);
  raw.content[0]!.data = 'mutated';
  assert.deepEqual(await store.get('snap-1'), { content: [{ type: 'image', data: 'original', mimeType: 'image/png' }], structuredContent: { hidden: true } });

  const smallStore = new ResultStore();
  const nonText = { content: [{ type: 'image', data: 'kept' }] };
  assert.equal(smallStore.present(nonText), nonText);
});

test('throws on MCP error results and caps adversarial shape metadata', () => {
  const store = new ResultStore({ inlineBytes: 4, id: () => 'bounded' });
  assert.throws(() => store.present({ isError: true, content: [{ type: 'text', text: 'bad request' }] }), /bad request/);

  const hostileKey = 'x"\n'.repeat(3000);
  const value = { [hostileKey]: 'value', rows: [{ [hostileKey]: 1 }] };
  const metadata = store.present({ content: [{ type: 'text', text: JSON.stringify(value) }] }) as { gatewayResult: { shape: unknown } };
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= 4096);
  assert.doesNotMatch(JSON.stringify(metadata.gatewayResult.shape), /value/);

  const nestedHostile = Object.fromEntries(Array.from({ length: 24 }, (_, property) => [
    `array-${property}`,
    Array.from({ length: 4 }, () => Object.fromEntries(Array.from({ length: 12 }, (_, key) => [`\"\\\\\n${property}-${key}`.repeat(18), true]))),
  ]));
  const manyArrays = store.present({ content: [{ type: 'text', text: JSON.stringify(nestedHostile) }] }) as { gatewayResult: { shape: unknown } };
  assert.ok(Buffer.byteLength(JSON.stringify(manyArrays)) <= 4096);
});

test('checks raw snapshot size even when the normalized value is small', () => {
  const store = new ResultStore({ maxTotalBytes: 80, inlineBytes: 80 });
  assert.throws(() => store.present({ content: [], structuredContent: { value: 'x'.repeat(100) } }), /exceeds the result-store capacity/);
});
