import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchIndex, type SearchOptions } from '../src/search.js';
import type { ToolEntry } from '../src/types.js';

function tool(server: string, name: string, description = ''): ToolEntry {
  return {
    server,
    name,
    description,
    inputSchema: { type: 'object', properties: { original: true } },
  };
}

function reference(tools: readonly ToolEntry[], options: SearchOptions = {}) {
  const limit =
    options.limit === undefined || !Number.isFinite(options.limit)
      ? 3
      : Math.max(0, Math.min(20, Math.floor(options.limit)));
  const selected = tools
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        (options.server === undefined || item.server === options.server) &&
        (options.tool === undefined || item.name === options.tool),
    );
  const query = options.query;
  if (query === undefined || query.trim().length === 0) {
    const browse = selected.sort(
      (a, b) =>
        a.item.server.localeCompare(b.item.server, 'en') ||
        a.item.name.localeCompare(b.item.name, 'en') ||
        a.index - b.index,
    );
    return {
      tools: browse.slice(0, limit).map(({ item }) => item),
      matched: selected.length,
    };
  }
  const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (terms.length === 0) return { tools: [], matched: 0 };
  const docs: string[][] = tools.map(
    (item) =>
      `${item.server} ${item.name} ${item.description ?? ''}`
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [],
  );
  const avgdl =
    docs.reduce((sum, tokens) => sum + tokens.length, 0) / (docs.length || 1);
  const scores: Array<{ item: ToolEntry; index: number; score: number }> = [];
  for (const { item, index } of selected) {
    const tf = new Map<string, number>();
    for (const token of docs[index]) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const frequency = tf.get(term) ?? 0;
      if (!frequency) continue;
      const df = docs.reduce(
        (count, doc) => count + (doc.includes(term) ? 1 : 0),
        0,
      );
      const idf = Math.log(1 + (tools.length - df + 0.5) / (df + 0.5));
      score +=
        (idf * (frequency * 2.2)) /
        (frequency +
          1.2 * (1 - 0.75 + (0.75 * docs[index].length) / (avgdl || 1)));
    }
    if (score > 0) scores.push({ item, index, score });
  }
  scores.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.server.localeCompare(b.item.server, 'en') ||
      a.item.name.localeCompare(b.item.name, 'en') ||
      a.index - b.index,
  );
  return {
    tools: scores.slice(0, limit).map(({ item }) => item),
    matched: scores.length,
  };
}

function assertMatchesReference(
  tools: ToolEntry[],
  options: SearchOptions,
): void {
  const actual = createSearchIndex(tools).search(options);
  const expected = reference(tools, options);
  assert.equal(actual.matched, expected.matched, JSON.stringify(options));
  assert.deepEqual(actual.tools, expected.tools, JSON.stringify(options));
}

test('BM25 agrees with an independent formula and preserves original tool entries', () => {
  const tools = [
    tool('zeta', 'Archive_Search', 'Find historical archive documents'),
    tool('alpha', 'archive_lookup', 'archive archive lookup'),
    tool('alpha', 'date_range', 'Search historical documents by date range'),
    tool('beta', 'history', 'historical records and archives'),
    tool('alpha', 'same', 'shared unique'),
    tool('alpha', 'same', 'shared unique'),
    tool('beta', 'other', 'shared unique'),
  ];
  const options: SearchOptions[] = [
    { query: 'historical archive' },
    { query: 'archive archive historical', limit: 20 },
    { query: 'shared unique' },
    { query: 'unique', server: 'alpha' },
    { query: 'shared', tool: 'same' },
    { query: 'shared', server: 'alpha', tool: 'same' },
    { query: 'shared', server: 'missing' },
    { query: 'shared', tool: 'missing' },
    { query: 'no-match' },
    { query: '--- !!!' },
    { query: '   ' },
    { query: undefined, server: 'alpha', limit: 2 },
    { query: '', limit: 1 },
  ];
  for (const option of options) assertMatchesReference(tools, option);
  const result = createSearchIndex(tools).search({ query: 'archive' });
  assert.ok(tools.includes(result.tools[0]));
  assert.equal(
    result.tools[0].inputSchema,
    tools.find((item) => item === result.tools[0])?.inputSchema,
  );
});

test('deterministic generated corpora match the reference across filters and repeated query tokens', () => {
  let state = 0x4f1bbcdc;
  const random = (bound: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % bound;
  };
  const vocabulary = [
    'records',
    'archive',
    'lookup',
    'daily',
    'weather',
    'history',
    'account',
    'search',
    'regional',
    'report',
  ];
  for (let corpus = 0; corpus < 12; corpus += 1) {
    const tools = Array.from({ length: 1 + random(60) }, (_, i) => {
      const name = `${vocabulary[random(vocabulary.length)]}_${i}`;
      const description = Array.from(
        { length: random(15) },
        () => vocabulary[random(vocabulary.length)],
      ).join(' ');
      return tool(`server-${random(4)}`, name, description);
    });
    for (const query of [
      'archive records',
      'weather weather report',
      'zzzz',
      'history-account',
      '###',
    ]) {
      for (const filters of [
        {},
        { server: `server-${random(4)}` },
        { tool: tools[random(tools.length)].name },
      ]) {
        assertMatchesReference(tools, { query, ...filters, limit: random(25) });
      }
    }
  }
});

test('long tokenized queries count repeated terms without scanning unmatched documents', () => {
  const tools = Array.from({ length: 300 }, (_, i) =>
    tool(`s${i % 3}`, `tool${i}`, i % 7 === 0 ? 'needle other' : 'other data'),
  );
  const query = Array(200).fill('needle').join(' ');
  assertMatchesReference(tools, { query, limit: 20, server: 's1' });
});

test('server aliases help distinguish tools with identical names and descriptions', () => {
  const tools = [
    tool('worknotes', 'list_files', 'List files in a folder'),
    tool('engineering', 'list_files', 'List files in a folder'),
  ];
  const index = createSearchIndex(tools);
  const result = index.search({ query: 'worknotes list files', limit: 2 });
  assert.deepEqual(result.tools, [tools[0], tools[1]]);
  assert.equal(result.matched, 2);
  assertMatchesReference(tools, { query: 'worknotes list files', limit: 2 });
  assertMatchesReference(tools, {
    query: 'worknotes list files',
    server: 'engineering',
    limit: 2,
  });
});
