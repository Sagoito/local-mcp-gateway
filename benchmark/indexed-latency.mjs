#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value);
const key = (server, name) => JSON.stringify([server, name]);
const EXPECTED_OLD_SERVER_SHA = '3987637b6afa303d9a9bc62f8dd0f0bd68ff763e5fede9485a34c651f22a4193';
const EXPECTED_OLD_RUNNER_SHA = 'bf37c2641514eaa557ca8ea3ecfb5f175a7ec180f2f152f995812c7934e1654a';

async function directoryHashes(dir, prefix = '') {
  const out = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(out, await directoryHashes(resolve(dir, item.name), rel));
    else if (item.isFile()) out[rel] = sha256(await readFile(resolve(dir, item.name)));
  }
  return out;
}
function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
}
function stats(values) {
  return { count: values.length, mean: values.reduce((s, x) => s + x, 0) / (values.length || 1), p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: values.length ? Math.max(...values) : null };
}
function sampleByCategory(queries, maxPerCategory, seed) {
  const random = rng(seed), groups = new Map();
  for (const q of queries) if (q.query.length <= 500) {
    const category = q.category ?? '(unspecified)';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(q);
  }
  const selected = [];
  for (const [category, values] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const shuffled = [...values];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    selected.push(...shuffled.slice(0, maxPerCategory).map(q => ({ ...q, _benchmarkCategory: category })));
  }
  return selected;
}
function toolEntry(t) { return { server: 'public', name: t.name, description: t.description, inputSchema: { type: 'object', properties: {} } }; }
function parseResult(result) {
  if (result.isError) throw new Error(JSON.parse(result.content?.find(x => x.type === 'text')?.text ?? '{}').error ?? 'search returned isError');
  const body = JSON.parse(result.content?.find(x => x.type === 'text')?.text ?? '{}');
  if (!Array.isArray(body.results)) throw new Error('missing results array');
  return body.results;
}
async function connectCondition(name, createGateway, tools) {
  const upstreams = { listTools: async () => tools, callTool: async () => { throw new Error('retrieval only'); }, close: async () => {} };
  const server = createGateway(upstreams, undefined, tools, () => [], () => []);
  const client = new Client({ name: `indexed-latency-${name}`, version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}
async function loadCondition(distDir, label, tools) {
  const serverPath = resolve(distDir, 'server.js');
  const hashes = await directoryHashes(distDir);
  if (label === 'old' && hashes['server.js'] !== EXPECTED_OLD_SERVER_SHA) throw new Error(`Old compiled gateway server.js SHA mismatch: ${hashes['server.js']}`);
  const mod = await import(`${pathToFileURL(serverPath).href}?latency=${label}`);
  if (typeof mod.createGateway !== 'function') throw new Error(`${label} dist has no createGateway export`);
  return { label, hashes, createGateway: mod.createGateway, tools };
}
function memory() { const m = process.memoryUsage(); return { rssBytes: m.rss, heapUsedBytes: m.heapUsed, externalBytes: m.external, osMaxRssBytes: process.resourceUsage().maxRSS * 1024 }; }
function percentileCI(samples) { return [percentile(samples, .025), percentile(samples, .975)]; }
function bootstrapPairs(pairs, samples = 1000, seed = 901) {
  const random = rng(seed), perQuery = new Map();
  for (const pair of pairs) {
    if (!perQuery.has(pair.queryId)) perQuery.set(pair.queryId, []);
    perQuery.get(pair.queryId).push(pair);
  }
  const queryPairs = [...perQuery.values()].map(reps => ({
    old: reps.reduce((s, p) => s + p.oldMs, 0) / reps.length,
    current: reps.reduce((s, p) => s + p.currentMs, 0) / reps.length,
    ratio: reps.reduce((s, p) => s + p.oldMs / Math.max(p.currentMs, 1e-9), 0) / reps.length,
  }));
  const values = { oldMeanMs: [], currentMeanMs: [], oldOverCurrentRatio: [] };
  for (let b = 0; b < samples; b++) {
    let old = 0, current = 0, ratio = 0;
    for (let i = 0; i < queryPairs.length; i++) { const p = queryPairs[Math.floor(random() * queryPairs.length)]; old += p.old; current += p.current; ratio += p.ratio; }
    values.oldMeanMs.push(old / queryPairs.length); values.currentMeanMs.push(current / queryPairs.length); values.oldOverCurrentRatio.push(ratio / queryPairs.length);
  }
  return { seed, samples, unit: 'query; each sampled query contributes its two-repetition mean and paired old/current ratio', oldMeanMs95CI: percentileCI(values.oldMeanMs), currentMeanMs95CI: percentileCI(values.currentMeanMs), oldOverCurrentRatio95CI: percentileCI(values.oldOverCurrentRatio), note: 'Sampling variation across this query sample only; not server, provider, model, or network variability.' };
}

async function main(datasetPath, oldDistDir, outputDir) {
  const processStart = memory();
  const latencyRunnerPath = fileURLToPath(import.meta.url);
  const latencyRunnerSha256 = sha256(await readFile(latencyRunnerPath));
  const v10ProtocolPath = resolve(ROOT, 'benchmark/results/public-v10/protocol.json');
  const v10ProtocolBytes = await readFile(v10ProtocolPath);
  JSON.parse(v10ProtocolBytes.toString('utf8'));
  const v10ProtocolSha256 = sha256(v10ProtocolBytes);
  const datasetBytes = await readFile(datasetPath), data = JSON.parse(datasetBytes.toString('utf8'));
  if (!Array.isArray(data.tools) || !Array.isArray(data.queries)) throw new Error('Expected normalized public dataset');
  const outManifest = resolve(outputDir, 'manifest.json');
  try { await readFile(outManifest); throw new Error(`Refusing to overwrite completed output: ${outputDir}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tools = data.tools.map(toolEntry), idByKey = new Map(data.tools.map(t => [key('public', t.name), t.id]));
  const currentDistDir = resolve(ROOT, 'dist');
  const old = await loadCondition(oldDistDir, 'old', tools);
  const current = await loadCondition(currentDistDir, 'current', tools);
  const oldSource = await readFile(resolve(ROOT, 'benchmark/public-retrieval.mjs'));
  if (sha256(oldSource) !== EXPECTED_OLD_RUNNER_SHA) throw new Error('Frozen original runner SHA differs from expected public-v9 runner');
  if (old.hashes['server.js'] !== EXPECTED_OLD_SERVER_SHA) throw new Error('Frozen compiled gateway server.js differs from verified v9 SHA');
  const v9ManifestBytes = await readFile(resolve(ROOT, 'benchmark/results/public-v9/manifest.json'));
  const v9Manifest = JSON.parse(v9ManifestBytes.toString('utf8'));
  if (stable(old.hashes) !== stable(v9Manifest.hashes?.distFilesBefore)) throw new Error('Frozen old dist directory files do not exactly match public-v9 distFilesBefore manifest');
  const seed = 104729, maxPerCategory = 30, reps = 2, selected = sampleByCategory(data.queries, maxPerCategory, seed);
  if (!selected.length) throw new Error('No queries of 500 characters or less are available');
  const clients = {
    old: await connectCondition('old', old.createGateway, tools),
    current: await connectCondition('current', current.createGateway, tools),
  };
  const firstCall = {}, warmupMs = {};
  const errors = { old: 0, current: 0 }, warmupErrors = { old: 0, current: 0 };
  const rssStart = memory(), peakRssBytes = { value: rssStart.rssBytes };
  const pairs = [], rawTrials = [];
  try {
    const defs = {};
    for (const condition of ['old', 'current']) {
      const listed = await clients[condition].listTools();
      if (!Array.isArray(listed.tools) || listed.tools.length !== 2) throw new Error(`${condition} must expose exactly two initial SDK tool definitions; got ${listed.tools?.length}`);
      if (!listed.tools.some(t => t.name === 'search') || !listed.tools.some(t => t.name === 'execute')) throw new Error(`${condition} initial definitions do not include search and execute`);
      defs[condition] = listed.tools;
    }
    // First call is timed separately, then nine additional calls complete a ten-query warmup.
    for (const condition of ['old', 'current']) {
      let total = 0;
      for (let i = 0; i < 10; i++) {
        const q = selected[i % selected.length], start = performance.now();
        try { parseResult(await clients[condition].callTool({ name: 'search', arguments: { query: q.query, includeSchema: false, limit: 10 } })); }
        catch { warmupErrors[condition]++; }
        const elapsed = performance.now() - start; total += elapsed;
        if (i === 0) firstCall[condition] = elapsed;
      }
      warmupMs[condition] = total;
    }
    // Alternating order removes a fixed first/second bias within each query/repetition pair.
    for (let rep = 0; rep < reps; rep++) for (let qi = 0; qi < selected.length; qi++) {
      const q = selected[qi], first = (qi + rep) % 2 === 0 ? 'old' : 'current';
      const order = [first, first === 'old' ? 'current' : 'old'], measured = {};
      for (const condition of order) {
        const start = performance.now(); let ids = [], error = null;
        try {
          const results = parseResult(await clients[condition].callTool({ name: 'search', arguments: { query: q.query, includeSchema: false, limit: 10 } }));
          ids = results.map(t => idByKey.get(key(t.server, t.name)));
          if (ids.some(id => id === undefined) || new Set(ids).size !== ids.length || ids.length > 10) throw new Error('invalid tool ID result');
        } catch (e) { error = String(e?.message ?? e); ids = []; errors[condition]++; }
        const elapsed = performance.now() - start;
        measured[condition] = { elapsed, ids, error };
        rawTrials.push({ queryId: q.id, querySha256: sha256(q.query), category: q._benchmarkCategory, repetition: rep + 1, order, condition, runtimeMs: elapsed, rankingSha256: sha256(stable(ids)), error });
      }
      pairs.push({ queryId: q.id, querySha256: sha256(q.query), category: q._benchmarkCategory, repetition: rep + 1, order, oldMs: measured.old.elapsed, currentMs: measured.current.elapsed, speedRatioOldOverCurrent: measured.old.elapsed / Math.max(measured.current.elapsed, 1e-9), oldError: measured.old.error, currentError: measured.current.error });
      peakRssBytes.value = Math.max(peakRssBytes.value, process.memoryUsage().rss);
    }
    // Token-proxy work is deliberately post-trial so tokenizer initialization cannot perturb timings.
    const tokenizers = await import('js-tiktoken');
    const encoding = tokenizers.getEncoding('o200k_base');
    const definitionProxies = {};
    for (const condition of ['old', 'current']) {
      const serialized = stable(defs[condition]);
      definitionProxies[condition] = { definitionCount: defs[condition].length, definitionJsonBytes: Buffer.byteLength(serialized), o200kBaseTokenProxy: encoding.encode(serialized).length };
    }
    encoding.free?.();
    const querySha256 = sha256(selected.map(q => `${q.id}\0${sha256(q.query)}`).join('\n'));
    const latency = { old: [], current: [] };
    for (const p of pairs) { latency.old.push(p.oldMs); latency.current.push(p.currentMs); }
    if (sha256(await readFile(datasetPath)) !== sha256(datasetBytes)) throw new Error('Dataset file changed during latency benchmark');
    if (stable(await directoryHashes(oldDistDir)) !== stable(old.hashes)) throw new Error('Frozen old dist changed during latency benchmark');
    if (stable(await directoryHashes(currentDistDir)) !== stable(current.hashes)) throw new Error('Current dist changed during latency benchmark');
    if (sha256(await readFile(resolve(ROOT, 'benchmark/public-retrieval.mjs'))) !== EXPECTED_OLD_RUNNER_SHA) throw new Error('Original public runner changed during latency benchmark');
    if (sha256(await readFile(latencyRunnerPath)) !== latencyRunnerSha256) throw new Error('Indexed latency runner changed during benchmark');
    if (sha256(await readFile(v10ProtocolPath)) !== v10ProtocolSha256) throw new Error('Public-v10 protocol changed during latency benchmark');
    const root = {
      metadata: { benchmark: 'indexed gateway local retrieval latency', dataset: data.metadata?.benchmark ?? 'normalized ToolRet-full', sampledQueries: selected.length, repetitions: reps, queryLimit: 500, perCategoryCap: maxPerCategory, querySampleSeed: seed },
      hashes: { datasetSha256: sha256(datasetBytes), indexedLatencyRunnerSha256: latencyRunnerSha256, publicV10ProtocolSha256: v10ProtocolSha256, oldDistFilesSha256: old.hashes, currentDistFilesSha256: current.hashes, oldServerSha256: old.hashes['server.js'], currentServerSha256: current.hashes['server.js'], originalPublicRunnerSha256: sha256(oldSource), publicV9ManifestSha256: sha256(v9ManifestBytes), queryIdAndQueryHashSha256: querySha256 },
      sourceProof: { oldCompiledServerSha256: EXPECTED_OLD_SERVER_SHA, oldOriginalRunnerSha256: EXPECTED_OLD_RUNNER_SHA },
      initialSdkToolDefinitions: definitionProxies,
      indexInitialization: { firstColdSearchMs: firstCall, tenQueryWarmupTotalMs: warmupMs, warmupCount: 10 },
      latencyMs: { old: stats(latency.old), current: stats(latency.current), pairedSpeedRatioOldOverCurrent: stats(pairs.map(p => p.speedRatioOldOverCurrent)), bootstrap95CI: bootstrapPairs(pairs), errors: { trials: errors, warmup: warmupErrors, definition: 'All trial search errors are retained in rows and scored as empty result rankings; warmup errors are separately counted.' } },
      memory: { processStart, final: memory(), peakObservedRssBytes: Math.max(peakRssBytes.value, process.resourceUsage().maxRSS * 1024), scope: 'One process hosts both gateway indexes; RSS cannot be attributed to either condition separately. OS maxRSS covers total process peak.' },
      methodology: { transport: 'MCP SDK over InMemoryTransport', catalog: 'same 44,453 original tool names/descriptions/IDs, no schema, same adapter', searchArgs: { includeSchema: false, limit: 10 }, conditionOrder: 'balanced alternating order within each query/repetition pair', calls: 'local only; no provider, model, network, or upstream I/O', confidenceInterval: 'bootstrap resampling of paired query means; sampling uncertainty only', timing: 'query SDK round-trip; includes per-query search tokenization; excludes process start, index startup, definition token-proxy calculation, and JSON output writing' },
      sample: selected.map(q => ({ queryId: q.id, querySha256: sha256(q.query), category: q._benchmarkCategory })),
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(resolve(outputDir, 'trials.jsonl'), rawTrials.map(r => JSON.stringify(r)).join('\n') + '\n');
    await writeFile(resolve(outputDir, 'pairs.jsonl'), pairs.map(r => JSON.stringify(r)).join('\n') + '\n');
    await writeFile(outManifest, JSON.stringify(root, null, 2) + '\n');
    console.log(`completed ${selected.length} sampled queries × ${reps} repetitions; old p50 ${root.latencyMs.old.p50.toFixed(3)} ms, indexed p50 ${root.latencyMs.current.p50.toFixed(3)} ms`);
  } finally { await Promise.all(Object.values(clients).map(c => c.close())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3] || !process.argv[4]) { console.error('Usage: node benchmark/indexed-latency.mjs <normalized-dataset.json> <baseline-dist-dir> <output-dir>'); process.exitCode = 2; }
  else main(resolve(process.argv[2]), resolve(process.argv[3]), resolve(process.argv[4])).catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
}
