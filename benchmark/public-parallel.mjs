#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { macroMetrics, evaluateRanking } from './public-retrieval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WORKERS = 8;
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function directoryHashes(dir, prefix = '') {
  const hashes = {};
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(hashes, await directoryHashes(resolve(dir, entry.name), name));
    else if (entry.isFile()) hashes[name] = sha256(await readFile(resolve(dir, entry.name)));
  }
  return hashes;
}

function validateData(data) {
  if (!data || !data.metadata || !Array.isArray(data.tools) || !Array.isArray(data.queries)) throw new Error('Expected {metadata, tools, queries} normalized JSON');
  const ids = new Set(), names = new Set();
  for (const [i, tool] of data.tools.entries()) {
    if (!tool || typeof tool.id !== 'string' || typeof tool.name !== 'string' || typeof tool.description !== 'string') throw new Error(`Invalid tool at index ${i}`);
    if (ids.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
    const nameKey = JSON.stringify(['public', tool.name]);
    if (names.has(nameKey)) throw new Error(`Duplicate public tool name: ${tool.name}`);
    ids.add(tool.id); names.add(nameKey);
  }
  const qids = new Set();
  for (const [i, query] of data.queries.entries()) {
    if (!query || typeof query.id !== 'string' || typeof query.query !== 'string' || !query.relevance || typeof query.relevance !== 'object' || Array.isArray(query.relevance)) throw new Error(`Invalid query at index ${i}`);
    if (qids.has(query.id)) throw new Error(`Duplicate query id: ${query.id}`);
    qids.add(query.id);
    for (const [id, gain] of Object.entries(query.relevance)) {
      if (!ids.has(id)) throw new Error(`Unknown qrel tool id ${id} for query ${query.id}`);
      if (!Number.isFinite(gain) || gain <= 0) throw new Error(`Invalid qrel gain for ${query.id}/${id}`);
    }
  }
  return data;
}

function runnerConfig(data) {
  return { protocol: 'MCP SDK Client/Server over InMemoryTransport', server: 'public', search: { includeSchema: false, limit: 10 }, warmup: { count: 10, fixedQueries: data.queries.slice(0, 10).map(q => q.id) }, baseline: { name: 'BM25', k1: 1.2, b: 0.75, idf: 'log(1+(N-df+0.5)/(df+0.5))', tokenizer: 'lowercase [a-z0-9]+', document: 'name + description', tieBreak: 'alphabetic name then id' }, metrics: 'macro; gains are linear; DCG gain/log2(rank+1); precision denominator is cutoff k; completeness@k is 1 iff every relevant item is within k; retained query text is represented by SHA-256 only', datasets: { tools: data.tools.length, queries: data.queries.length } };
}

function parseGzipJsonl(buffer) {
  const text = gunzipSync(buffer).toString('utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function writeGzipJsonl(path, rows) {
  await pipeline(async function* () { for (const row of rows) yield `${JSON.stringify(row)}\n`; }(), createGzip({ level: 9, mtime: 0 }), createWriteStream(path));
}
function runChild(inputPath, outputDir) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [resolve(HERE, 'public-retrieval.mjs'), inputPath, outputDir], { cwd: ROOT, stdio: 'inherit' });
    child.once('error', error => resolvePromise({ code: null, error: String(error) }));
    child.once('close', (code, signal) => resolvePromise({ code, signal: signal ?? null }));
  });
}
function macroByGroup(rows) {
  const summary = {};
  for (const field of ['category', 'source']) {
    summary[field] = {};
    const groups = new Map();
    for (const row of rows) {
      const label = row[field] ?? '(unspecified)';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(row);
    }
    for (const [label, subset] of groups) summary[field][label] = { ...macroMetrics(subset), errors: subset.filter(row => row.error).length };
  }
  return summary;
}
function assertRow(row, query, knownToolIds, label) {
  if (!row || row.queryId !== query.id || row.querySha256 !== sha256(query.query)) throw new Error(`${label}: query identity/hash mismatch for ${query.id}`);
  if (JSON.stringify(row.qrels) !== JSON.stringify(query.relevance)) throw new Error(`${label}: qrels mismatch for ${query.id}`);
  if (!Array.isArray(row.ranking) || row.ranking.some(id => !knownToolIds.has(id)) || new Set(row.ranking).size !== row.ranking.length) throw new Error(`${label}: unknown or duplicate result IDs for ${query.id}`);
  const expected = evaluateRanking(row.ranking, query.relevance);
  if (JSON.stringify(expected) !== JSON.stringify(row.metrics)) throw new Error(`${label}: metric mismatch for ${query.id}`);
}

async function main(datasetPath, outputDir, checkpointPath) {
  const inputBytes = await readFile(datasetPath);
  const inputHash = sha256(inputBytes);
  const data = validateData(JSON.parse(inputBytes.toString('utf8')));
  const knownToolIds = new Set(data.tools.map(tool => tool.id));
  const originalRunnerPath = resolve(HERE, 'public-retrieval.mjs');
  const coordinatorPath = fileURLToPath(import.meta.url);
  const originalRunnerHash = sha256(await readFile(originalRunnerPath));
  const coordinatorHash = sha256(await readFile(coordinatorPath));
  const distHashesBefore = await directoryHashes(resolve(ROOT, 'dist'));
  const config = runnerConfig(data);
  const configHash = sha256(JSON.stringify(config));
  const checkpointFingerprints = { datasetSha256: inputHash, runnerSha256: originalRunnerHash, configSha256: configHash, distFilesSha256: distHashesBefore };
  const prefixGateway = [], prefixBm25 = [];
  if (checkpointPath) {
    let checkpoint;
    try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
    catch (error) { throw new Error(`Could not read requested checkpoint ${checkpointPath}: ${error.message}`); }
    if (JSON.stringify(checkpoint.fingerprints) !== JSON.stringify(checkpointFingerprints)) throw new Error('Checkpoint dataset, runner, config, or dist fingerprints do not match current frozen inputs');
    if (!Array.isArray(checkpoint.gatewayRows) || !Array.isArray(checkpoint.baselineRows) || checkpoint.gatewayRows.length !== checkpoint.baselineRows.length || checkpoint.gatewayRows.length > data.queries.length) throw new Error('Checkpoint row counts are invalid');
    for (let i = 0; i < checkpoint.gatewayRows.length; i++) {
      assertRow(checkpoint.gatewayRows[i], data.queries[i], knownToolIds, 'checkpoint gateway');
      assertRow(checkpoint.baselineRows[i], data.queries[i], knownToolIds, 'checkpoint BM25');
    }
    prefixGateway.push(...checkpoint.gatewayRows);
    prefixBm25.push(...checkpoint.baselineRows);
    console.log(`validated sequential prefix: ${prefixGateway.length}/${data.queries.length}`);
  }

  await mkdir(outputDir, { recursive: true });
  const shardRoot = resolve(ROOT, '.local', 'public-shards', randomUUID());
  await mkdir(shardRoot, { recursive: true });
  const remaining = data.queries.slice(prefixGateway.length);
  const partitions = Array.from({ length: WORKERS }, () => []);
  remaining.forEach((query, i) => partitions[i % WORKERS].push(query));
  const shards = partitions.map((queries, index) => ({
    index,
    queries,
    inputPath: resolve(shardRoot, `shard-${String(index + 1).padStart(2, '0')}.json`),
    outputDir: resolve(outputDir, `shard-${String(index + 1).padStart(2, '0')}`),
  }));
  for (const shard of shards) {
    await writeFile(shard.inputPath, JSON.stringify({ metadata: data.metadata, tools: data.tools, queries: shard.queries }));
    await mkdir(shard.outputDir, { recursive: true });
  }
  console.log(`dispatching ${remaining.length} remaining queries across ${WORKERS} full-corpus shards`);
  const outcomes = await Promise.all(shards.map(async shard => ({ shard, ...(await runChild(shard.inputPath, shard.outputDir)) })));

  const gatewayById = new Map(prefixGateway.map(row => [row.queryId, row]));
  const bm25ById = new Map(prefixBm25.map(row => [row.queryId, row]));
  const shardReports = [];
  for (const outcome of outcomes) {
    const { shard } = outcome;
    const report = { shard: shard.index + 1, queryCount: shard.queries.length, inputSha256: sha256(await readFile(shard.inputPath)), exitCode: outcome.code, signal: outcome.signal ?? null, spawnError: outcome.error ?? null, files: {} };
    try {
      if (outcome.code !== 0) throw new Error(`Worker exited with code ${outcome.code} signal ${outcome.signal ?? 'none'}`);
      const manifestBytes = await readFile(resolve(shard.outputDir, 'manifest.json'));
      report.manifestSha256 = sha256(manifestBytes);
      report.manifest = JSON.parse(manifestBytes.toString('utf8'));
      const workerManifest = report.manifest;
      if (workerManifest.hashes?.datasetSha256 !== report.inputSha256) throw new Error('Worker manifest dataset hash does not match shard input');
      if (workerManifest.hashes?.runnerSha256 !== originalRunnerHash) throw new Error('Worker manifest runner hash does not match frozen runner');
      if (JSON.stringify(workerManifest.hashes?.distFilesSha256) !== JSON.stringify(distHashesBefore)) throw new Error('Worker manifest dist hashes do not match frozen gateway');
      if (JSON.stringify(workerManifest.metadata) !== JSON.stringify(data.metadata)) throw new Error('Worker manifest metadata differs from original dataset');
      if (workerManifest.hashes?.configSha256 !== sha256(JSON.stringify(workerManifest.config))) throw new Error('Worker manifest config hash is invalid');
      const expectedWorkerConfig = runnerConfig({ tools: data.tools, queries: shard.queries });
      if (JSON.stringify(workerManifest.config) !== JSON.stringify(expectedWorkerConfig)) throw new Error('Worker config or search scenario differs from frozen runner configuration');
      if (workerManifest.summary?.gateway?.queries !== shard.queries.length || workerManifest.summary?.bm25?.queries !== shard.queries.length) throw new Error('Worker summary query counts do not match shard');
      report.validation = { datasetHash: true, runnerHash: true, distHashes: true, configScenario: true, queryCount: true };
      const staged = { gateway: [], bm25: [] };
      for (const [kind, target] of [['gateway', gatewayById], ['bm25', bm25ById]]) {
        const path = resolve(shard.outputDir, `${kind}.jsonl.gz`);
        const bytes = await readFile(path);
        report.files[`${kind}.jsonl.gz`] = sha256(bytes);
        const rows = parseGzipJsonl(bytes);
        if (rows.length !== shard.queries.length) throw new Error(`${kind} row count ${rows.length} != ${shard.queries.length}`);
        for (let i = 0; i < rows.length; i++) {
          const query = shard.queries[i];
          assertRow(rows[i], query, knownToolIds, `shard ${shard.index + 1} ${kind}`);
          if (target.has(query.id) || staged[kind].some(row => row.queryId === query.id)) throw new Error(`Duplicate result query ${query.id}`);
          staged[kind].push(rows[i]);
        }
      }
      const expectedQrels = shard.queries.reduce((sum, query) => sum + Object.keys(query.relevance).length, 0);
      for (const kind of ['gateway', 'bm25']) {
        const found = staged[kind].reduce((sum, row) => sum + Object.keys(row.qrels).length, 0);
        if (found !== expectedQrels) throw new Error(`${kind} qrels count ${found} != expected ${expectedQrels}`);
      }
      report.validation.qrelsCount = true;
      report.validation.passed = true;
      for (const kind of ['gateway', 'bm25']) for (const row of staged[kind]) (kind === 'gateway' ? gatewayById : bm25ById).set(row.queryId, row);
      report.executionDone = true;
    } catch (error) {
      report.readError = String(error?.message ?? error);
      report.validation = { ...(report.validation ?? {}), passed: false };
      report.executionDone = false;
      for (const query of shard.queries) {
        const failureRow = { queryId: query.id, querySha256: sha256(query.query), category: query.category ?? null, source: query.source ?? null, ranking: [], ranks: {}, qrels: query.relevance, metrics: evaluateRanking([], query.relevance), error: `shard_failed: ${report.readError}`, runtimeMs: null };
        if (!prefixGateway.some(row => row.queryId === query.id)) {
          gatewayById.set(query.id, { ...failureRow });
          bm25ById.set(query.id, { ...failureRow });
        }
      }
    }
    shardReports.push(report);
  }

  const gatewayRows = data.queries.map(query => gatewayById.get(query.id));
  const baselineRows = data.queries.map(query => bm25ById.get(query.id));
  for (let i = 0; i < data.queries.length; i++) {
    if (!gatewayRows[i] || !baselineRows[i]) throw new Error(`Aggregate missing query ${data.queries[i].id}`);
    assertRow(gatewayRows[i], data.queries[i], knownToolIds, 'aggregate gateway');
    assertRow(baselineRows[i], data.queries[i], knownToolIds, 'aggregate BM25');
  }
  const outputQrelsCount = gatewayRows.reduce((sum, row) => sum + Object.keys(row.qrels).length, 0);
  const allQueriesMapped = gatewayRows.length === data.queries.length && baselineRows.length === data.queries.length &&
    new Set(gatewayRows.map(row => row.queryId)).size === data.queries.length && new Set(baselineRows.map(row => row.queryId)).size === data.queries.length;
  if (outputQrelsCount !== data.queries.reduce((sum, query) => sum + Object.keys(query.relevance).length, 0)) throw new Error('Aggregate qrels count differs from original dataset');
  const distHashesAfter = await directoryHashes(resolve(ROOT, 'dist'));
  if (JSON.stringify(distHashesAfter) !== JSON.stringify(distHashesBefore)) throw new Error('Gateway dist files changed during parallel run');
  await writeGzipJsonl(resolve(outputDir, 'gateway.jsonl.gz'), gatewayRows);
  await writeGzipJsonl(resolve(outputDir, 'bm25.jsonl.gz'), baselineRows);
  const qrelsCount = data.queries.reduce((sum, query) => sum + Object.keys(query.relevance).length, 0);
  const manifest = {
    metadata: data.metadata,
    config: { ...config, execution: { workers: WORKERS, partition: 'round-robin over remaining original-order queries; every shard receives the full unchanged tool corpus', sequentialPrefixQueries: prefixGateway.length, latencyInterpretation: 'Sequential-prefix queries ran sequentially; workspace scheduling can affect timings. Worker timings include eight-worker CPU contention.' } },
    hashes: { datasetSha256: inputHash, coordinatorSha256: coordinatorHash, originalRunnerSha256: originalRunnerHash, configSha256: configHash, distFilesBefore: distHashesBefore, distFilesAfter: distHashesAfter },
    executionDone: allQueriesMapped && shardReports.every(report => report.executionDone),
    validation: { passed: allQueriesMapped && outputQrelsCount === qrelsCount && shardReports.every(report => report.validation?.passed !== false), tools: data.tools.length, queries: data.queries.length, allQueriesMapped, uniqueQueryIds: new Set(data.queries.map(q => q.id)).size, qrelsCount, outputQrelsCount, unknownQrelToolIds: 0, unknownOrDuplicateOutputIds: 0 },
    sequentialPrefix: { queries: prefixGateway.length, gatewayErrors: prefixGateway.filter(row => row.error).length, gatewayRuntimeMs: { p50: percentile(prefixGateway.map(row => row.runtimeMs).filter(Number.isFinite), .5), p95: percentile(prefixGateway.map(row => row.runtimeMs).filter(Number.isFinite), .95) }, bm25RuntimeMs: { p50: percentile(prefixBm25.map(row => row.runtimeMs).filter(Number.isFinite), .5), p95: percentile(prefixBm25.map(row => row.runtimeMs).filter(Number.isFinite), .95) } },
    summary: {
      gateway: { ...macroMetrics(gatewayRows), errors: gatewayRows.filter(row => row.error).length, byCategorySource: macroByGroup(gatewayRows) },
      bm25: { ...macroMetrics(baselineRows), errors: baselineRows.filter(row => row.error).length, byCategorySource: macroByGroup(baselineRows) },
    },
    parallelSdkRuntimeMs: { p50: percentile(gatewayRows.slice(prefixGateway.length).map(row => row.runtimeMs).filter(Number.isFinite), .5), p95: percentile(gatewayRows.slice(prefixGateway.length).map(row => row.runtimeMs).filter(Number.isFinite), .95), note: 'Per-query local SDK round-trip time under eight-worker CPU contention; not end-to-end user answer latency.' },
    shards: shardReports,
  };
  await writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`aggregate complete: ${data.queries.length} queries; gateway errors ${manifest.summary.gateway.errors}; output ${resolve(outputDir)}`);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) {
    console.error('Usage: node benchmark/public-parallel.mjs <normalized.json> <output-dir> [checkpoint.json]');
    process.exitCode = 2;
  } else {
    main(resolve(process.argv[2]), resolve(process.argv[3]), process.argv[4] ? resolve(process.argv[4]) : undefined)
      .catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
  }
}
