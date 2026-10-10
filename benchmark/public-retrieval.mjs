#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGateway } from '../dist/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const tokenize = value => String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function directoryHashes(dir, prefix = '') {
  const result = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(result, await directoryHashes(resolve(dir, item.name), relative));
    else if (item.isFile()) result[relative] = sha256(await readFile(resolve(dir, item.name)));
  }
  return result;
}
const stablePair = (a, b) => String(a.name).localeCompare(String(b.name), 'en') || String(a.id).localeCompare(String(b.id), 'en');

/** BM25 with the frozen public-retrieval parameters. Documents use name and description only. */
export function rankBM25(query, tools, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = tools.map(tool => ({ tool, tokens: tokenize(`${tool.name} ${tool.description ?? ''}`) }));
  const avgdl = docs.reduce((n, d) => n + d.tokens.length, 0) / (docs.length || 1);
  const df = new Map();
  for (const d of docs) for (const term of new Set(d.tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  const qterms = tokenize(query);
  const scored = docs.map(d => {
    const tf = new Map();
    for (const term of d.tokens) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of qterms) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = docs.length, dft = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.tokens.length / (avgdl || 1)));
    }
    return { tool: d.tool, score };
  });
  return scored.sort((a, b) => b.score - a.score || stablePair(a.tool, b.tool)).map(x => x.tool);
}

/** Pre-indexed BM25 equivalent; query-time work visits only matching postings. */
export function createBM25Index(tools, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = tools.map(tool => {
    const tokens = tokenize(`${tool.name} ${tool.description ?? ''}`);
    const tf = new Map();
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1);
    return { tool, length: tokens.length, tf };
  });
  const avgdl = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1);
  const postings = new Map();
  for (let i = 0; i < docs.length; i++) {
    for (const [term, frequency] of docs[i].tf) {
      let posting = postings.get(term);
      if (!posting) postings.set(term, posting = []);
      posting.push([i, frequency]);
    }
  }
  const n = docs.length;
  const idf = new Map([...postings].map(([term, list]) => [term, Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5))]));
  const zeroOrder = docs.map((_, i) => i).sort((a, b) => stablePair(docs[a].tool, docs[b].tool));
  return {
    size: n,
    rank(query, limit = 10) {
      const scores = new Map();
      for (const term of tokenize(query)) {
        for (const [index, frequency] of postings.get(term) ?? []) {
          const doc = docs[index];
          const score = (idf.get(term) * (frequency * (k1 + 1))) /
            (frequency + k1 * (1 - b + b * doc.length / (avgdl || 1)));
          scores.set(index, (scores.get(index) ?? 0) + score);
        }
      }
      const hits = [...scores].sort((a, b) => b[1] - a[1] || stablePair(docs[a[0]].tool, docs[b[0]].tool));
      const result = hits.slice(0, limit).map(([index]) => docs[index].tool);
      if (result.length < limit) {
        const positive = new Set(scores.keys());
        for (const index of zeroOrder) {
          if (!positive.has(index)) result.push(docs[index].tool);
          if (result.length >= limit) break;
        }
      }
      return result;
    },
  };
}

/** Graded metrics with linear gains and ideal DCG from the query's full qrels. */
export function evaluateRanking(ranking, relevance) {
  const gains = relevance ?? {};
  const relevantIds = Object.keys(gains).filter(id => Number(gains[id]) > 0);
  const uniqueRanking = [...new Set(ranking)];
  const rank = new Map();
  uniqueRanking.forEach((id, i) => rank.set(id, i + 1));
  const dcgAt = k => uniqueRanking.slice(0, k).reduce((sum, id, i) => sum + (Number(gains[id]) > 0 ? Number(gains[id]) / Math.log2(i + 2) : 0), 0);
  const ideal = relevantIds.map(id => Number(gains[id])).sort((a, b) => b - a);
  const idcgAt = k => ideal.slice(0, k).reduce((sum, gain, i) => sum + gain / Math.log2(i + 2), 0);
  const first = relevantIds.map(id => rank.get(id)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return {
    hit1: relevantIds.some(id => rank.get(id) <= 1) ? 1 : 0,
    hit5: relevantIds.some(id => rank.get(id) <= 5) ? 1 : 0,
    hit10: relevantIds.some(id => rank.get(id) <= 10) ? 1 : 0,
    recall5: relevantIds.length ? relevantIds.filter(id => rank.get(id) <= 5).length / relevantIds.length : 0,
    recall10: relevantIds.length ? relevantIds.filter(id => rank.get(id) <= 10).length / relevantIds.length : 0,
    precision5: uniqueRanking.slice(0, 5).filter(id => Number(gains[id]) > 0).length / 5,
    precision10: uniqueRanking.slice(0, 10).filter(id => Number(gains[id]) > 0).length / 10,
    completeness5: relevantIds.length > 0 && relevantIds.every(id => rank.get(id) <= 5) ? 1 : 0,
    completeness10: relevantIds.length > 0 && relevantIds.every(id => rank.get(id) <= 10) ? 1 : 0,
    mrr10: first && first <= 10 ? 1 / first : 0,
    ndcg5: idcgAt(5) ? dcgAt(5) / idcgAt(5) : 0,
    ndcg10: idcgAt(10) ? dcgAt(10) / idcgAt(10) : 0,
  };
}

export function macroMetrics(rows, field = 'metrics') {
  const keys = ['hit1','hit5','hit10','precision5','precision10','recall5','recall10','completeness5','completeness10','mrr10','ndcg5','ndcg10'];
  const out = Object.fromEntries(keys.map(k => [k, rows.length ? rows.reduce((s, row) => s + (row[field]?.[k] ?? 0), 0) / rows.length : 0]));
  return { queries: rows.length, ...out };
}

function validateData(data) {
  if (!data || !data.metadata || !Array.isArray(data.tools) || !Array.isArray(data.queries)) throw new Error('Expected {metadata, tools, queries} normalized JSON');
  const ids = new Set();
  const names = new Set();
  for (const [i, t] of data.tools.entries()) {
    if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.description !== 'string') throw new Error(`Invalid tool at index ${i}`);
    if (ids.has(t.id)) throw new Error(`Duplicate tool id: ${t.id}`);
    const uniqueName = JSON.stringify(['public', t.name]);
    if (names.has(uniqueName)) throw new Error(`Duplicate tool name in server public: ${t.name}`);
    ids.add(t.id);
    names.add(uniqueName);
  }
  const qids = new Set();
  for (const [i, q] of data.queries.entries()) {
    if (!q || typeof q.id !== 'string' || typeof q.query !== 'string' || !q.relevance || typeof q.relevance !== 'object' || Array.isArray(q.relevance)) throw new Error(`Invalid query at index ${i}`);
    if (qids.has(q.id)) throw new Error(`Duplicate query id: ${q.id}`);
    qids.add(q.id);
    for (const [id, gain] of Object.entries(q.relevance)) {
      if (!ids.has(id)) throw new Error(`Query ${q.id} has unknown relevant tool id: ${id}`);
      if (!Number.isFinite(gain) || gain <= 0) throw new Error(`Query ${q.id} has invalid positive gain for ${id}`);
    }
  }
  return data;
}

function toolEntry(t) {
  return { server: 'public', name: t.name, description: t.description, inputSchema: { type: 'object', properties: {} } };
}
const gatewayKey = (server, name) => JSON.stringify([server, name]);
function parseText(result) {
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  return JSON.parse(text);
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function main(inputPath, outputDir) {
  const inputBytes = await readFile(inputPath);
  const data = validateData(JSON.parse(inputBytes.toString('utf8')));
  const entries = data.tools.map(toolEntry);
  const entryIdByKey = new Map(data.tools.map(t => [gatewayKey('public', t.name), t.id]));
  const bm25 = createBM25Index(data.tools);
  const distHashesBefore = await directoryHashes(resolve(ROOT, 'dist'));
  const upstreams = { listTools: async () => entries, callTool: async () => { throw new Error('Retrieval-only benchmark: upstream execution is disabled'); }, close: async () => {} };
  // Keep the real search catalog in the upstream and initial snapshot while
  // avoiding embedding every published description into execute's long help text.
  const gateway = createGateway(upstreams, undefined, entries, () => [], () => []);
  const client = new Client({ name: 'public-retrieval-benchmark', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), gateway.connect(st)]);
  await mkdir(outputDir, { recursive: true });
  try {
    const listed = await client.listTools();
    if (listed.tools.length !== 2 || !listed.tools.some(t => t.name === 'search') || !listed.tools.some(t => t.name === 'execute')) throw new Error(`Expected exactly the gateway's search and execute tools; got ${listed.tools.map(t => t.name).join(', ')}`);
    const corpusHashBefore = sha256(JSON.stringify(data.tools));
    const config = { protocol: 'MCP SDK Client/Server over InMemoryTransport', server: 'public', search: { includeSchema: false, limit: 10 }, warmup: { count: 10, fixedQueries: data.queries.slice(0, 10).map(q => q.id) }, baseline: { name: 'BM25', k1: 1.2, b: 0.75, idf: 'log(1+(N-df+0.5)/(df+0.5))', tokenizer: 'lowercase [a-z0-9]+', document: 'name + description', tieBreak: 'alphabetic name then id' }, metrics: 'macro; gains are linear; DCG gain/log2(rank+1); precision denominator is cutoff k; completeness@k is 1 iff every relevant item is within k; retained query text is represented by SHA-256 only', datasets: { tools: data.tools.length, queries: data.queries.length } };
    const runnerHash = sha256(await readFile(fileURLToPath(import.meta.url)));
    const configHash = sha256(JSON.stringify(config));
    const checkpointFingerprints = { datasetSha256: sha256(inputBytes), runnerSha256: runnerHash, configSha256: configHash, distFilesSha256: distHashesBefore };
    const warm = data.queries.slice(0, 10);
    for (const q of warm) {
      try { await client.callTool({ name: 'search', arguments: { query: q.query, includeSchema: false, limit: 10 } }); } catch {}
      bm25.rank(q.query, 10);
    }
    const progressPath = resolve(outputDir, 'progress.json');
    let gatewayRows = [], baselineRows = [];
    try {
      const checkpoint = JSON.parse(await readFile(progressPath, 'utf8'));
      const checkpointCount = checkpoint.gatewayRows?.length;
      const matchesPrefix = Number.isInteger(checkpointCount) && checkpointCount <= data.queries.length &&
        checkpointCount === checkpoint.baselineRows?.length &&
        checkpoint.gatewayRows.every((row, i) => row.queryId === data.queries[i]?.id) &&
        checkpoint.baselineRows.every((row, i) => row.queryId === data.queries[i]?.id);
      if (JSON.stringify(checkpoint.fingerprints) === JSON.stringify(checkpointFingerprints) && matchesPrefix) {
        gatewayRows = checkpoint.gatewayRows;
        baselineRows = checkpoint.baselineRows;
        console.log(`resuming at ${gatewayRows.length}/${data.queries.length} queries`);
      }
    } catch {}
    const gatewayTimes = gatewayRows.map(row => row.runtimeMs), baselineTimes = baselineRows.map(row => row.runtimeMs);
    for (let i = gatewayRows.length; i < data.queries.length; i++) {
      const q = data.queries[i];
      const start = performance.now();
      let ranking = [], error = null;
      try {
        const result = await client.callTool({ name: 'search', arguments: { query: q.query, includeSchema: false, limit: 10 } });
        if (result.isError) throw new Error(parseText(result).error ?? 'Gateway search returned isError');
        const body = parseText(result);
        ranking = body.results.map(t => {
          const id = entryIdByKey.get(gatewayKey(t.server, t.name));
          if (id === undefined) throw new Error(`Gateway returned unknown tool ${t.server}/${t.name}`);
          return id;
        });
        if (new Set(ranking).size !== ranking.length) throw new Error('Gateway returned duplicate tool ids');
      } catch (e) { error = String(e?.message ?? e); ranking = []; }
      const elapsedMs = performance.now() - start;
      gatewayTimes.push(elapsedMs);
      gatewayRows.push({ queryId: q.id, querySha256: sha256(q.query), category: q.category ?? null, source: q.source ?? null, ranking, ranks: Object.fromEntries(ranking.map((id, n) => [id, n + 1])), qrels: q.relevance, metrics: evaluateRanking(ranking, q.relevance), error, runtimeMs: elapsedMs });

      const bstart = performance.now();
      const branking = bm25.rank(q.query, 10).map(t => t.id);
      const belapsedMs = performance.now() - bstart;
      baselineTimes.push(belapsedMs);
      baselineRows.push({ queryId: q.id, querySha256: sha256(q.query), category: q.category ?? null, source: q.source ?? null, ranking: branking, ranks: Object.fromEntries(branking.map((id, n) => [id, n + 1])), qrels: q.relevance, metrics: evaluateRanking(branking, q.relevance), error: null, runtimeMs: belapsedMs });
      if ((i + 1) % 1000 === 0) {
        const checkpointPath = `${progressPath}.tmp`;
        await writeFile(checkpointPath, JSON.stringify({ fingerprints: checkpointFingerprints, gatewayRows, baselineRows }));
        await rename(checkpointPath, progressPath);
        console.log(`processed and checkpointed ${i + 1}/${data.queries.length} queries`);
      }
    }
    if (sha256(JSON.stringify(data.tools)) !== corpusHashBefore) throw new Error('Input corpus changed during benchmark');
    const distHashesAfter = await directoryHashes(resolve(ROOT, 'dist'));
    if (JSON.stringify(distHashesAfter) !== JSON.stringify(distHashesBefore)) throw new Error('Gateway dist files changed during benchmark');
    const corpusBytes = Buffer.byteLength(JSON.stringify(data.tools));
    const byGroup = rows => {
      const summary = {};
      for (const field of ['category', 'source']) {
        summary[field] = {};
        const groups = new Map();
        for (const row of rows) {
          const value = row[field] ?? '(unspecified)';
          if (!groups.has(value)) groups.set(value, []);
          groups.get(value).push(row);
        }
        for (const [value, grouped] of groups) summary[field][value] = { ...macroMetrics(grouped), errors: grouped.filter(row => row.error).length };
      }
      return summary;
    };
    const manifest = { metadata: data.metadata, config, hashes: { datasetSha256: sha256(inputBytes), runnerSha256: runnerHash, configSha256: configHash, distFilesSha256: distHashesBefore, corpusSha256: corpusHashBefore }, sizes: { inputBytes: inputBytes.length, corpusJsonBytes: corpusBytes }, summary: { gateway: { ...macroMetrics(gatewayRows), errors: gatewayRows.filter(row => row.error).length, byCategorySource: byGroup(gatewayRows) }, bm25: { ...macroMetrics(baselineRows), errors: 0, byCategorySource: byGroup(baselineRows) } }, latencyMs: { gatewaySdkRoundTrip: { p50: percentile(gatewayTimes, .5), p95: percentile(gatewayTimes, .95) }, bm25RankOnly: { p50: percentile(baselineTimes, .5), p95: percentile(baselineTimes, .95) }, note: 'Measured sequential local runtimes; not user-facing answer latency.' } };
    await writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const [name, rows] of [['gateway', gatewayRows], ['bm25', baselineRows]]) {
      const path = resolve(outputDir, `${name}.jsonl.gz`);
      await pipeline(async function* () { for (const row of rows) yield `${JSON.stringify(row)}\n`; }(), createGzip({ level: 9, mtime: 0 }), createWriteStream(path));
    }
    await unlink(progressPath).catch(() => {});
    console.log(`completed ${data.queries.length} queries; gateway Hit@1 ${manifest.summary.gateway.hit1.toFixed(4)}, BM25 Hit@1 ${manifest.summary.bm25.hit1.toFixed(4)}; outputs ${resolve(outputDir)}`);
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) { console.error('Usage: node benchmark/public-retrieval.mjs <normalized.json> <output-dir>'); process.exitCode = 2; }
  else main(resolve(process.argv[2]), resolve(process.argv[3])).catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
}
