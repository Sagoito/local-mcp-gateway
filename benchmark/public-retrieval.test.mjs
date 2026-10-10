import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBM25Index,
  evaluateRanking,
  macroMetrics,
  rankBM25,
} from './public-retrieval.mjs';

test('graded metrics use linear gains and ideal graded DCG', () => {
  const relevance = { a: 3, b: 1, c: 2 };
  const metrics = evaluateRanking(['b', 'a', 'x'], relevance);
  assert.equal(metrics.hit1, 1);
  assert.equal(metrics.recall5, 2 / 3);
  assert.equal(metrics.mrr10, 1);
  const dcg = 1 + 3 / Math.log2(3);
  const idcg = 3 + 2 / Math.log2(3) + 1 / 2;
  assert.ok(Math.abs(metrics.ndcg5 - dcg / idcg) < 1e-12);
  assert.equal(metrics.ndcg10, metrics.ndcg5);
});

test('duplicate ranking entries count once; absent and empty qrels score zero', () => {
  const duplicate = evaluateRanking(['a', 'a', 'b'], { a: 2, b: 1 });
  const unique = evaluateRanking(['a', 'b'], { a: 2, b: 1 });
  assert.deepEqual(duplicate, unique);
  assert.deepEqual(evaluateRanking(['a'], { b: 1 }), {
    hit1: 0,
    hit5: 0,
    hit10: 0,
    recall5: 0,
    recall10: 0,
    precision5: 0,
    precision10: 0,
    completeness5: 0,
    completeness10: 0,
    mrr10: 0,
    ndcg5: 0,
    ndcg10: 0,
  });
  assert.equal(evaluateRanking([], {}).ndcg10, 0);
});

test('completeness is binary at the cutoff, separate from fractional recall', () => {
  const partial = evaluateRanking(['a', 'x', 'b'], { a: 1, b: 1, c: 1 });
  assert.equal(partial.recall5, 2 / 3);
  assert.equal(partial.completeness5, 0);
  assert.equal(partial.completeness10, 0);
  const complete = evaluateRanking(['a', 'b', 'c'], { a: 1, b: 1, c: 1 });
  assert.equal(complete.completeness5, 1);
  assert.equal(complete.completeness10, 1);
  assert.equal(evaluateRanking([], {}).completeness5, 0);
});

test('pre-indexed BM25 reproduces reference top ranks, including zero-score tie fill', () => {
  const tools = [
    {
      id: 'id-10',
      name: 'z_find_items',
      description: 'Find and retrieve items by a searchable phrase.',
    },
    {
      id: 'id-2',
      name: 'a_search',
      description: 'Search items and documents.',
    },
    {
      id: 'id-3',
      name: 'b_search',
      description: 'Search items and documents.',
    },
    { id: 'id-4', name: 'c_user', description: 'Return user profiles.' },
    { id: 'id-5', name: 'd_empty', description: '' },
  ];
  const index = createBM25Index(tools);
  for (const query of [
    'search items',
    'find find phrase',
    'unknown token',
    '',
    'user_profile',
  ]) {
    assert.deepEqual(
      index.rank(query, 4).map((t) => t.id),
      rankBM25(query, tools)
        .slice(0, 4)
        .map((t) => t.id),
      query,
    );
  }
});

test('BM25 ties are stable by alphabetic name then id and tokenizes underscore-separated words', () => {
  const tools = [
    { id: 'z', name: 'z_tool', description: 'search records' },
    { id: 'b', name: 'a_tool', description: 'search records' },
    { id: 'a', name: 'a_tool', description: 'search records' },
  ];
  assert.deepEqual(
    rankBM25('search', tools).map((x) => x.id),
    ['a', 'b', 'z'],
  );
  const underscore = [
    { id: 'x', name: 'list_open_issues', description: '' },
    { id: 'y', name: 'unrelated', description: 'open issues' },
  ];
  assert.deepEqual(
    rankBM25('open_issues', underscore).map((x) => x.id),
    ['x', 'y'],
  );
});

test('macro metrics average query-level scores equally', () => {
  const one = evaluateRanking(['a'], { a: 1 });
  const zero = evaluateRanking([], { a: 1 });
  const result = macroMetrics([{ metrics: one }, { metrics: zero }]);
  assert.equal(result.queries, 2);
  assert.equal(result.hit1, 0.5);
  assert.equal(result.recall10, 0.5);
});
