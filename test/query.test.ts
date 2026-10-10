import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryInput, queryResult } from '../src/query.js';

test('validates strict query inputs and applies defaults', () => {
  assert.deepEqual(queryInput.parse({ id: 'saved' }), {
    id: 'saved',
    path: [],
    where: [],
    action: 'all',
  });
  assert.throws(
    () => queryInput.parse({ id: 'saved', extra: true }),
    /Unrecognized key/,
  );
  assert.throws(() => queryInput.parse({ id: '' }), /too_small/);
  assert.throws(
    () =>
      queryInput.parse({
        id: 'saved',
        where: [{ field: [], op: 'eq', value: 1 }],
      }),
    /too_small/,
  );
  assert.throws(
    () =>
      queryInput.parse({
        id: 'saved',
        where: [{ field: ['x'], op: 'eq', value: Number.NaN }],
      }),
    /invalid_union/,
  );
});

test('filters JSON text and structuredContent with paths, scalar comparisons, and projections', () => {
  const records = [
    { id: 1, profile: { score: 10 }, active: true, note: null, extra: 'omit' },
    { id: 2, profile: { score: 14 }, active: true, note: 'x', extra: 'omit' },
    { id: 3, profile: { score: 20 }, active: false, extra: 'omit' },
  ];
  const query = queryInput.parse({
    id: 'retained',
    path: ['payload', 'rows'],
    where: [
      { field: ['profile', 'score'], op: 'gte', value: 14 },
      { field: ['active'], op: 'eq', value: true },
    ],
    fields: ['id', 'profile', 'missing'],
  });
  const textResult = {
    content: [
      { type: 'text', text: JSON.stringify({ payload: { rows: records } }) },
    ],
  };
  assert.deepEqual(queryResult(textResult, query), [
    { id: 2, profile: { score: 14 } },
  ]);

  const structured = {
    content: [],
    structuredContent: { payload: { rows: records } },
  };
  assert.deepEqual(
    queryResult(
      structured,
      queryInput.parse({
        id: 'retained',
        path: ['payload', 'rows'],
        action: 'first',
      }),
    ),
    records[0],
  );
  assert.equal(
    queryResult(
      structured,
      queryInput.parse({
        id: 'retained',
        path: ['payload', 'rows'],
        action: 'count',
        where: [{ field: ['profile', 'score'], op: 'lt', value: 15 }],
      }),
    ),
    2,
  );
});

test('missing fields never satisfy any operator, including ne', () => {
  const raw = {
    content: [
      {
        type: 'text',
        text: '[{"a":1},{"b":2},{"a":null},{"a":{"nested":true}},{"a":[1]}]',
      },
    ],
  };
  const query = queryInput.parse({
    id: 'x',
    where: [{ field: ['missing'], op: 'ne', value: null }],
  });
  assert.deepEqual(queryResult(raw, query), []);
  const neQuery = queryInput.parse({
    id: 'x',
    where: [{ field: ['a'], op: 'ne', value: 2 }],
  });
  assert.deepEqual(queryResult(raw, neQuery), [{ a: 1 }, { a: null }]);
  const nullQuery = queryInput.parse({
    id: 'x',
    where: [{ field: ['a'], op: 'eq', value: null }],
  });
  assert.deepEqual(queryResult(raw, nullQuery), [{ a: null }]);
});

test('supports own prototype-named data keys without traversing inherited properties', () => {
  const raw: { content: { type: string; text: string }[] } = {
    content: [
      {
        type: 'text',
        text: '{"rows":[{"__proto__":{"polluted":true},"constructor":"own"},{}]}',
      },
    ],
  };
  const query = queryInput.parse({
    id: 'x',
    path: ['rows'],
    fields: ['__proto__', 'constructor', 'toString'],
  });
  const result = queryResult(raw, query);
  assert.deepEqual(
    result,
    JSON.parse('[{"__proto__":{"polluted":true},"constructor":"own"},{}]'),
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('first returns null when no rows match and paths must resolve through own properties', () => {
  const raw = { content: [{ type: 'text', text: '{"rows":[]}' }] };
  assert.equal(
    queryResult(
      raw,
      queryInput.parse({ id: 'x', path: ['rows'], action: 'first' }),
    ),
    null,
  );
  assert.throws(
    () => queryResult(raw, queryInput.parse({ id: 'x', path: ['toString'] })),
    /does not exist/,
  );
  assert.throws(
    () => queryResult(raw, queryInput.parse({ id: 'x', path: ['missing'] })),
    /does not exist/,
  );
});

test('rejects MCP errors, non-JSON, non-text, non-array selections, and oversized inputs', () => {
  const input = queryInput.parse({ id: 'x' });
  assert.throws(
    () =>
      queryResult(
        { isError: true, content: [{ type: 'text', text: 'bad call' }] },
        input,
      ),
    /bad call/,
  );
  assert.throws(
    () =>
      queryResult({ content: [{ type: 'text', text: 'plain text' }] }, input),
    /valid JSON/,
  );
  assert.throws(
    () => queryResult({ content: [{ type: 'image', data: 'x' }] }, input),
    /non-text/,
  );
  assert.throws(
    () => queryResult({ content: [{ type: 'text', text: '{"x":1}' }] }, input),
    /must resolve to an array/,
  );
  assert.throws(
    () =>
      queryResult(
        {
          content: [{ type: 'text', text: `[${'null,'.repeat(100_000)}null]` }],
        },
        input,
      ),
    /maximum is 100000/,
  );
});

test('rejects work that exceeds the operation-visit cap instead of truncating', () => {
  const data = Array.from({ length: 63_000 }, () => ({}));
  const fields = Array.from({ length: 16 }, (_, i) => `f${i}`);
  const query = queryInput.parse({ id: 'x', fields });
  assert.throws(
    () => queryResult({ content: [], structuredContent: data }, query),
    /operation-visit limit/,
  );
});
