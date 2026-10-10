import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCatalog } from '../src/catalog.js';
import type { ToolEntry } from '../src/types.js';

test('renders deterministic sorted signatures with bounded schema hints', () => {
  const tools: ToolEntry[] = [
    { server: 'zeta', name: 'go', inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } },
    { server: 'alpha', name: 'read', inputSchema: { type: 'object', properties: {
      mode: { enum: ['fast', 'safe'] }, values: { type: 'array', items: { type: 'number' } },
      data: { anyOf: [{ type: 'string' }, { type: 'null' }] }, extra: { $ref: '#/defs/Extra' },
    }, required: ['mode'], additionalProperties: false } },
  ];
  const result = renderCatalog(tools);
  assert.ok(result.startsWith('\nAvailable MCP signatures'));
  assert.ok(result.indexOf('"alpha","read"') < result.indexOf('"zeta","go"'));
  assert.match(result, /"mode": "fast" \| "safe";/);
  assert.match(result, /"values"\?: Array<number>;/);
  assert.match(result, /"data"\?: string \| null;/);
  assert.match(result, /"extra"\?: unknown;/);
  assert.match(result, /"count": number;/);
  assert.doesNotMatch(result, /additionalProperties|description/);
  assert.equal(renderCatalog([...tools].reverse()), result);
});

test('rejects over-budget and over-cap catalogues as a whole', () => {
  const tool: ToolEntry = { server: 's', name: 't', inputSchema: { type: 'object', properties: {} } };
  const full = renderCatalog([tool]);
  assert.ok(full.length > 0);
  assert.equal(renderCatalog([tool], Buffer.byteLength(full) - 1), '');
  assert.equal(renderCatalog([tool], Buffer.byteLength(full)), full);
  assert.equal(renderCatalog(Array.from({ length: 65 }, (_, i) => ({ ...tool, name: `t${i}` }))), '');
  assert.equal(renderCatalog([]), '');
});

test('escapes schema keys and tool identifiers, and degrades complex schemas safely', () => {
  const weirdKey = 'x"; malicious: any; //\n';
  const schema: Record<string, unknown> = { type: 'object', properties: {
    [weirdKey]: { type: 'string' }, tooDeep: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'string' } } } } } } } } },
    choices: { oneOf: [{ const: 'ignored' }, { type: 'boolean' }] },
  } };
  const result = renderCatalog([{ server: 'sv"\n', name: 'tool);evil(', inputSchema: schema }]);
  assert.ok(result.includes(JSON.stringify('sv"\n')));
  assert.ok(result.includes(JSON.stringify('tool);evil(')));
  assert.ok(result.includes(JSON.stringify(weirdKey)));
  assert.ok(result.includes(`${JSON.stringify(weirdKey)}?: string;`));
  assert.match(result, /"tooDeep"\?: \{ "a"\?: \{ "b"\?: \{ "c"\?: \{ "d"\?: unknown/);
  assert.match(result, /"choices"\?: unknown \| boolean;/);

  const cyclic: Record<string, unknown> = { type: 'object', properties: {} };
  (cyclic.properties as Record<string, unknown>).loop = cyclic;
  assert.match(renderCatalog([{ server: 's', name: 'cycle', inputSchema: cyclic }]), /"loop"\?: unknown;/);
});

test('uses unknown hints for oversized or unsupported schema constructs', () => {
  const hugeProperties = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, { type: 'string' }]));
  const result = renderCatalog([{ server: 's', name: 't', inputSchema: { type: 'object', properties: {
    huge: { type: 'object', properties: hugeProperties },
    unsupported: { type: 'string', pattern: 'authoritative constraint' },
    additional: { type: 'object', additionalProperties: { $ref: '#/x' } },
  } } }]);
  assert.match(result, /"huge"\?: unknown;/);
  assert.match(result, /"unsupported"\?: string;/);
  assert.match(result, /\[key: string\]: unknown;/);
});
