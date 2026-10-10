#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGateway } from '../dist/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stableJson = (value) => JSON.stringify(value);
const jsonHash = (value) => sha256(stableJson(value));
const key = (server, name) => JSON.stringify([server, name]);

async function directoryHashes(dir, prefix = '') {
  const hashes = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, 'en'),
  )) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory())
      Object.assign(
        hashes,
        await directoryHashes(resolve(dir, item.name), rel),
      );
    else if (item.isFile())
      hashes[rel] = sha256(await readFile(resolve(dir, item.name)));
  }
  return hashes;
}

export function evaluateRanking(ranking, relevance) {
  const gains = relevance ?? {};
  const relevant = Object.keys(gains).filter((id) => Number(gains[id]) > 0);
  const unique = [...new Set(ranking)];
  const rank = new Map(unique.map((id, i) => [id, i + 1]));
  const dcg = (k) =>
    unique
      .slice(0, k)
      .reduce(
        (s, id, i) =>
          s +
          (Number(gains[id]) > 0 ? Number(gains[id]) / Math.log2(i + 2) : 0),
        0,
      );
  const ideal = relevant.map((id) => Number(gains[id])).sort((a, b) => b - a);
  const idcg = (k) =>
    ideal.slice(0, k).reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  const first = relevant
    .map((id) => rank.get(id))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return {
    hit1: relevant.some((id) => rank.get(id) <= 1) ? 1 : 0,
    hit5: relevant.some((id) => rank.get(id) <= 5) ? 1 : 0,
    hit10: relevant.some((id) => rank.get(id) <= 10) ? 1 : 0,
    recall5: relevant.length
      ? relevant.filter((id) => rank.get(id) <= 5).length / relevant.length
      : 0,
    recall10: relevant.length
      ? relevant.filter((id) => rank.get(id) <= 10).length / relevant.length
      : 0,
    precision5:
      unique.slice(0, 5).filter((id) => Number(gains[id]) > 0).length / 5,
    precision10:
      unique.slice(0, 10).filter((id) => Number(gains[id]) > 0).length / 10,
    completeness5:
      relevant.length > 0 && relevant.every((id) => rank.get(id) <= 5) ? 1 : 0,
    completeness10:
      relevant.length > 0 && relevant.every((id) => rank.get(id) <= 10) ? 1 : 0,
    mrr10: first && first <= 10 ? 1 / first : 0,
    ndcg5: idcg(5) ? dcg(5) / idcg(5) : 0,
    ndcg10: idcg(10) ? dcg(10) / idcg(10) : 0,
  };
}

function macro(rows) {
  const metrics = [
    'hit1',
    'hit5',
    'hit10',
    'precision5',
    'precision10',
    'recall5',
    'recall10',
    'completeness5',
    'completeness10',
    'mrr10',
    'ndcg5',
    'ndcg10',
  ];
  return {
    queries: rows.length,
    ...Object.fromEntries(
      metrics.map((m) => [
        m,
        rows.length
          ? rows.reduce((s, r) => s + (r.metrics?.[m] ?? 0), 0) / rows.length
          : 0,
      ]),
    ),
  };
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function toolEntry(t) {
  return {
    server: 'public',
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: {} },
  };
}
function parseText(result) {
  return JSON.parse(
    result.content?.find((item) => item.type === 'text')?.text ?? '',
  );
}
function validateData(data) {
  if (
    !data?.metadata ||
    !Array.isArray(data.tools) ||
    !Array.isArray(data.queries)
  )
    throw new Error('Expected normalized {metadata, tools, queries} dataset');
  const ids = new Set(),
    names = new Set();
  for (const t of data.tools) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.name !== 'string' ||
      typeof t.description !== 'string' ||
      ids.has(t.id)
    )
      throw new Error('Invalid or duplicate corpus tool');
    if (names.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    ids.add(t.id);
    names.add(t.name);
  }
  const qids = new Set();
  for (const q of data.queries) {
    if (
      !q ||
      typeof q.id !== 'string' ||
      typeof q.query !== 'string' ||
      !q.relevance ||
      typeof q.relevance !== 'object' ||
      Array.isArray(q.relevance) ||
      qids.has(q.id)
    )
      throw new Error('Invalid or duplicate query row');
    qids.add(q.id);
    for (const [id, gain] of Object.entries(q.relevance))
      if (!ids.has(id) || !Number.isFinite(gain) || gain <= 0)
        throw new Error(`Invalid qrel for ${q.id}/${id}`);
  }
  return data;
}
async function atomicJson(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}
async function readJsonlGzip(path) {
  const rows = [];
  let carry = '';
  for await (const chunk of createReadStream(path).pipe(createGunzip())) {
    carry += chunk.toString('utf8');
    let end;
    while ((end = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, end);
      carry = carry.slice(end + 1);
      if (line) rows.push(JSON.parse(line));
    }
  }
  if (carry.trim()) rows.push(JSON.parse(carry));
  return rows;
}
async function writeRows(path, rows) {
  await pipeline(
    (async function* () {
      for (const row of rows) yield `${JSON.stringify(row)}\n`;
    })(),
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(path),
  );
}
function validateRows(rows, data, label) {
  if (rows.length !== data.queries.length)
    throw new Error(
      `${label} has ${rows.length} rows; expected ${data.queries.length}`,
    );
  const ids = new Set(data.tools.map((t) => t.id));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i],
      q = data.queries[i];
    if (
      row.queryId !== q.id ||
      row.querySha256 !== sha256(q.query) ||
      stableJson(row.qrels) !== stableJson(q.relevance)
    )
      throw new Error(`${label} row ${i} does not match original query/qrels`);
    if (
      !Array.isArray(row.ranking) ||
      row.ranking.length > 10 ||
      new Set(row.ranking).size !== row.ranking.length ||
      row.ranking.some((id) => !ids.has(id))
    )
      throw new Error(`${label} row ${i} has invalid ranked tool IDs`);
    if (row.error && row.ranking.length)
      throw new Error(`${label} error row ${i} must have an empty ranking`);
    const expectedRanks = Object.fromEntries(
      row.ranking.map((id, ix) => [id, ix + 1]),
    );
    if (stableJson(row.ranks) !== stableJson(expectedRanks))
      throw new Error(
        `${label} row ${i} ranks object does not match ranked IDs`,
      );
    const expectedMetrics = evaluateRanking(row.ranking, q.relevance);
    for (const [metric, score] of Object.entries(expectedMetrics)) {
      if (
        !Number.isFinite(row.metrics?.[metric]) ||
        Math.abs(row.metrics[metric] - score) > 1e-12
      )
        throw new Error(`${label} row ${i} has invalid ${metric}`);
    }
  }
}
export async function validateBaseline(dir, datasetBytes, data) {
  const manifestBytes = await readFile(resolve(dir, 'manifest.json'));
  const auditBytes = await readFile(resolve(dir, 'audit.json'));
  const artifactsBytes = await readFile(resolve(dir, 'artifacts.json'));
  const manifest = JSON.parse(manifestBytes);
  const audit = JSON.parse(auditBytes.toString('utf8'));
  const artifacts = JSON.parse(artifactsBytes.toString('utf8'));
  for (const [name, bytes] of [
    ['manifest.json', manifestBytes],
    ['audit.json', auditBytes],
  ]) {
    const recorded = artifacts.included?.[name];
    if (
      !recorded ||
      recorded.bytes !== bytes.length ||
      recorded.sha256 !== sha256(bytes)
    )
      throw new Error(
        `Frozen baseline ${name} does not match artifacts.json recorded bytes/SHA-256`,
      );
  }
  const bmPath = resolve(dir, 'bm25.jsonl.gz');
  const bmBytes = await readFile(bmPath);
  const expected = artifacts.included?.['bm25.jsonl.gz'];
  if (
    !expected ||
    expected.bytes !== bmBytes.length ||
    expected.sha256 !== sha256(bmBytes)
  )
    throw new Error(
      'Frozen baseline bm25.jsonl.gz does not match artifacts.json recorded bytes/SHA-256',
    );
  if (
    audit.passed !== true ||
    manifest.executionDone !== true ||
    manifest.validation?.passed !== true
  )
    throw new Error(
      'Frozen baseline must have a passing audit and completed/passing manifest validation',
    );
  const dataHash = sha256(datasetBytes);
  if (
    manifest.hashes?.datasetSha256 !== dataHash ||
    sha256(datasetBytes) !== dataHash
  )
    throw new Error('Dataset SHA-256 does not match frozen baseline manifest');
  if (
    data.tools.length !== 44453 ||
    data.queries.length !== 7961 ||
    manifest.metadata?.tools !== 44453 ||
    manifest.metadata?.queries !== 7961
  )
    throw new Error(
      'Expected original ToolRet-full corpus (44,453 tools; 7,961 queries)',
    );
  const rows = await readJsonlGzip(bmPath);
  validateRows(rows, data, 'Frozen BM25 baseline');
  const expectedMetrics = audit.conditions?.bm25?.officialBackendMacroScores;
  if (
    audit.conditions?.bm25?.queriesAudited !== data.queries.length ||
    audit.conditions?.bm25?.errors !== rows.filter((r) => r.error).length
  )
    throw new Error(
      'Frozen baseline audit row/error counts do not match baseline rows',
    );
  for (const [metric, score] of Object.entries(expectedMetrics ?? {})) {
    const manifestScore = manifest.summary?.bm25?.[metric];
    if (
      !Number.isFinite(score) ||
      !Number.isFinite(manifestScore) ||
      Math.abs(manifestScore - score) > 1e-10
    )
      throw new Error(
        `Frozen baseline manifest/audit macro mismatch for ${metric}`,
      );
  }
  if (!expectedMetrics || Object.keys(expectedMetrics).length === 0)
    throw new Error('Frozen baseline audit has no official scalar metrics');
  return {
    rows,
    sha256: sha256(bmBytes),
    manifestSha256: sha256(manifestBytes),
    manifest,
    auditSha256: sha256(auditBytes),
    artifactsSha256: sha256(artifactsBytes),
    baselineBytes: bmBytes,
  };
}
function summaryBy(rows) {
  const out = {};
  for (const field of ['category', 'source']) {
    out[field] = {};
    const groups = new Map();
    for (const row of rows) {
      const v = row[field] ?? '(unspecified)';
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(row);
    }
    for (const [label, group] of groups)
      out[field][label] = {
        ...macro(group),
        errors: group.filter((r) => r.error).length,
      };
  }
  return out;
}
function processMemory() {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    externalBytes: m.external,
  };
}

async function main(datasetPath, baselineDir, outputDir) {
  const processStart = {
    memory: processMemory(),
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  try {
    await stat(resolve(outputDir, 'manifest.json'));
    throw new Error(`Refusing to overwrite completed output: ${outputDir}`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await mkdir(outputDir, { recursive: true });
  const datasetBytes = await readFile(datasetPath);
  const data = validateData(JSON.parse(datasetBytes.toString('utf8')));
  const frozen = await validateBaseline(baselineDir, datasetBytes, data);
  const baselineRows = frozen.rows;
  const toolsHashBefore = jsonHash(data.tools),
    queriesHashBefore = jsonHash(data.queries);
  const corpusHashBefore = toolsHashBefore;
  const distDir = resolve(ROOT, 'dist');
  const distBefore = await directoryHashes(distDir);
  if (!distBefore['server.js'])
    throw new Error(
      'Current dist/server.js is missing; build the indexed product before running',
    );
  const sourceFilesBefore = {};
  for (const path of ['src/server.ts', 'src/search.ts'])
    sourceFilesBefore[path] = sha256(await readFile(resolve(ROOT, path)));
  const tools = data.tools.map(toolEntry);
  const idByKey = new Map(data.tools.map((t) => [key('public', t.name), t.id]));
  const upstreams = {
    listTools: async () => tools,
    callTool: async () => {
      throw new Error('Retrieval-only benchmark: upstream execution disabled');
    },
    close: async () => {},
  };
  const gateway = createGateway(
    upstreams,
    undefined,
    tools,
    () => [],
    () => [],
  );
  const client = new Client({
    name: 'indexed-retrieval-benchmark',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    gateway.connect(serverTransport),
  ]);
  try {
    const listed = await client.listTools();
    if (
      listed.tools.length !== 2 ||
      !listed.tools.some((t) => t.name === 'search') ||
      !listed.tools.some((t) => t.name === 'execute')
    )
      throw new Error(
        `Expected only search and execute tools; received ${listed.tools.map((t) => t.name).join(', ')}`,
      );
    const warmQueries = data.queries.slice(0, 10);
    const warmStarts = [];
    for (const q of warmQueries) {
      const start = performance.now();
      try {
        await client.callTool({
          name: 'search',
          arguments: { query: q.query, includeSchema: false, limit: 10 },
        });
      } catch {
        /* Warmup failures are excluded from measured rankings. */
      }
      warmStarts.push(performance.now() - start);
    }
    const config = {
      protocol: 'MCP SDK Client/Server over InMemoryTransport',
      server: 'public',
      adapter:
        'unchanged original public corpus tool IDs/names/descriptions; each presented as public server tool',
      search: {
        includeSchema: false,
        limit: 10,
        productDefaultLimit: 3,
        activeSearchQueryLimit: 8192,
        queryOver500HistoricalCount: 360,
        historicalRejectionCount: 0,
        note: '500 characters was the historical v9 input limit; current product accepts up to 8192 characters.',
      },
      warmup: {
        count: 10,
        fixedQueries: warmQueries.map((q) => q.id),
        timingNote:
          'Ten sequential warmup calls are excluded from reported query latency; the complete original query set is then measured sequentially, including those same ten queries.',
      },
      indexedSearch: {
        name: 'Indexed BM25',
        document: 'server + name + description',
        tokenizer: 'lowercase [a-z0-9]+',
        k1: 1.2,
        b: 0.75,
        idf: 'log(1+(N-df+0.5)/(df+0.5))',
        matchingPostingsOnly: true,
        tieBreak:
          'alphabetic server/name using locale en, then original snapshot position',
      },
      baseline: {
        name: 'Frozen BM25 ranks from unchanged public-v9',
        document: 'name + description',
        k1: 1.2,
        b: 0.75,
        reusedWithoutReranking: true,
        runtimeInterpretation:
          'Historical rank-only runtimes from mixed infrastructure history; excluded from indexed-run latency comparison.',
      },
      timing: {
        gateway:
          'Sequential local SDK round-trip; first 10 queries warm the index and are excluded from primary latency percentiles; all queries including errors are retained.',
      },
      metrics:
        'Macro query averages; original qrels and original query order; linear gains; query text stored as SHA-256 only.',
      dataset: {
        tools: data.tools.length,
        queries: data.queries.length,
        qrels: Object.values(data.queries).reduce(
          (n, q) => n + Object.keys(q.relevance).length,
          0,
        ),
      },
    };
    const runnerBytes = await readFile(fileURLToPath(import.meta.url));
    const runnerHash = sha256(runnerBytes),
      configHash = jsonHash(config),
      datasetHash = sha256(datasetBytes);
    const fingerprints = {
      datasetSha256: datasetHash,
      runnerSha256: runnerHash,
      configSha256: configHash,
      distFilesSha256: distBefore,
      corpusSha256: corpusHashBefore,
      baselineBlobSha256: frozen.sha256,
      baselineManifestSha256: frozen.manifestSha256,
    };
    const progressPath = resolve(outputDir, 'progress.json');
    let rows = [];
    try {
      const checkpoint = JSON.parse(await readFile(progressPath, 'utf8'));
      const prefix = checkpoint.rows?.length;
      if (stableJson(checkpoint.fingerprints) !== stableJson(fingerprints))
        throw new Error(
          'Existing progress checkpoint fingerprints do not match dataset, runner, config, build, corpus, or frozen baseline; refusing to discard it',
        );
      if (!Number.isInteger(prefix) || prefix > data.queries.length)
        throw new Error(
          'Existing progress checkpoint has an invalid row count',
        );
      validateRows(
        checkpoint.rows,
        { ...data, queries: data.queries.slice(0, prefix) },
        'Existing progress checkpoint',
      );
      rows = checkpoint.rows;
      console.log(`resuming at ${rows.length}/${data.queries.length} queries`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const timings = rows.map((r) => r.runtimeMs),
      warmCount = 10;
    let peakRssBytes = Math.max(
      process.memoryUsage().rss,
      ...rows.map((r) => r.memory?.rssBytes ?? 0),
    );
    const firstSearchMs = warmStarts[0] ?? null;
    const indexReadyAfterWarmMs = warmStarts.reduce((s, x) => s + x, 0);
    const writeCheckpoint = async () =>
      atomicJson(progressPath, {
        fingerprints,
        rows,
        memory: { atCheckpoint: processMemory(), peakRssBytes },
      });
    for (let i = rows.length; i < data.queries.length; i++) {
      const q = data.queries[i],
        start = performance.now();
      let ranking = [],
        error = null;
      try {
        const result = await client.callTool({
          name: 'search',
          arguments: { query: q.query, includeSchema: false, limit: 10 },
        });
        if (result.isError)
          throw new Error(
            parseText(result).error ?? 'Gateway search returned isError',
          );
        const body = parseText(result);
        if (!Array.isArray(body.results))
          throw new Error('Gateway response has no results array');
        ranking = body.results.map((t) => {
          const id = idByKey.get(key(t.server, t.name));
          if (id === undefined)
            throw new Error(
              `Gateway returned unknown original tool ${t.server}/${t.name}`,
            );
          return id;
        });
        if (ranking.length > 10 || new Set(ranking).size !== ranking.length)
          throw new Error(
            'Gateway returned more than ten or duplicate tool IDs',
          );
      } catch (e) {
        error = String(e?.message ?? e);
        ranking = [];
      }
      const elapsed = performance.now() - start;
      timings.push(elapsed);
      rows.push({
        queryId: q.id,
        querySha256: sha256(q.query),
        category: q.category ?? null,
        source: q.source ?? null,
        ranking,
        ranks: Object.fromEntries(ranking.map((id, ix) => [id, ix + 1])),
        qrels: q.relevance,
        metrics: evaluateRanking(ranking, q.relevance),
        error,
        runtimeMs: elapsed,
      });
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      if ((i + 1) % 1000 === 0) {
        await writeCheckpoint();
        console.log(
          `checkpoint ${i + 1}/${data.queries.length}; RSS ${process.memoryUsage().rss}`,
        );
      }
    }
    validateRows(rows, data, 'Indexed gateway');
    if (
      jsonHash(data.tools) !== toolsHashBefore ||
      jsonHash(data.queries) !== queriesHashBefore
    )
      throw new Error('Dataset/corpus/query/qrels changed during benchmark');
    const distAfter = await directoryHashes(distDir);
    if (stableJson(distAfter) !== stableJson(distBefore))
      throw new Error('Current dist files changed during benchmark');
    if (sha256(await readFile(datasetPath)) !== datasetHash)
      throw new Error('Dataset file changed during benchmark');
    if (sha256(await readFile(fileURLToPath(import.meta.url))) !== runnerHash)
      throw new Error('Runner changed during benchmark');
    if (jsonHash(config) !== configHash)
      throw new Error('Benchmark config changed during benchmark');
    if (
      sha256(await readFile(resolve(baselineDir, 'bm25.jsonl.gz'))) !==
        frozen.sha256 ||
      sha256(await readFile(resolve(baselineDir, 'manifest.json'))) !==
        frozen.manifestSha256 ||
      sha256(await readFile(resolve(baselineDir, 'audit.json'))) !==
        frozen.auditSha256 ||
      sha256(await readFile(resolve(baselineDir, 'artifacts.json'))) !==
        frozen.artifactsSha256
    )
      throw new Error('Frozen baseline changed during benchmark');
    const sourceFilesAfter = {};
    for (const path of Object.keys(sourceFilesBefore))
      sourceFilesAfter[path] = sha256(await readFile(resolve(ROOT, path)));
    if (stableJson(sourceFilesAfter) !== stableJson(sourceFilesBefore))
      throw new Error('Gateway source files changed during benchmark');
    const corpusJsonBytes = Buffer.byteLength(stableJson(data.tools));
    const summary = {
      gateway: {
        ...macro(rows),
        errors: rows.filter((r) => r.error).length,
        byCategorySource: summaryBy(rows),
      },
      bm25: {
        ...macro(baselineRows),
        errors: baselineRows.filter((r) => r.error).length,
        byCategorySource: summaryBy(baselineRows),
      },
    };
    const manifest = {
      metadata: {
        ...data.metadata,
        tools: data.tools.length,
        queries: data.queries.length,
        queryOver500HistoricalCount: data.queries.filter(
          (q) => q.query.length > 500,
        ).length,
        historicalLimitExceededIsNotCurrentRejection: true,
      },
      config,
      hashes: {
        datasetSha256: datasetHash,
        corpusSha256: corpusHashBefore,
        queriesAndQrelsSha256: queriesHashBefore,
        runnerSha256: runnerHash,
        configSha256: configHash,
        sourceFilesBeforeSha256: sourceFilesBefore,
        sourceFilesAfterSha256: sourceFilesAfter,
        distFilesBeforeSha256: distBefore,
        distFilesAfterSha256: distAfter,
        baselineBlobSha256: frozen.sha256,
        baselineManifestSha256: frozen.manifestSha256,
        baselineAuditSha256: frozen.auditSha256,
        baselineArtifactsSha256: frozen.artifactsSha256,
      },
      sizes: { inputBytes: datasetBytes.length, corpusJsonBytes },
      executionDone: true,
      validation: {
        passed: true,
        tools: data.tools.length,
        queries: data.queries.length,
        allQueriesMapped: true,
        uniqueQueryIds: new Set(rows.map((r) => r.queryId)).size,
        qrelsCount: config.dataset.qrels,
        outputQrelsCount: rows.reduce(
          (n, r) => n + Object.keys(r.qrels).length,
          0,
        ),
        unknownQrelToolIds: 0,
        maxRanked: Math.max(...rows.map((r) => r.ranking.length)),
        duplicateRankedIds: false,
        errorsRetainedWithEmptyRanking: true,
        corpusUnchanged: true,
        queriesAndQrelsUnchanged: true,
        distUnchanged: true,
      },
      summary,
      latencyMs: {
        gatewaySdkSequential: {
          measuredQueries: timings.length,
          warmupExcluded: warmCount,
          p50: percentile(timings, 0.5),
          p95: percentile(timings, 0.95),
          p99: percentile(timings, 0.99),
          max: timings.length ? Math.max(...timings) : null,
        },
        indexedSearchInitialization: {
          firstColdSearchMs: firstSearchMs,
          tenQueryWarmupTotalMs: indexReadyAfterWarmMs,
        },
        historicalBm25RankOnly: {
          interpretation: config.baseline.runtimeInterpretation,
        },
      },
      memory: {
        processStart,
        checkpointAndFinal: {
          ...processMemory(),
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        },
        peakObservedRssBytes: Math.max(
          peakRssBytes,
          process.resourceUsage().maxRSS * 1024,
        ),
        note: 'RSS is process-wide and includes gateway, index, SDK, and benchmark data; OS maxRSS is process-wide.',
      },
    };
    await writeRows(resolve(outputDir, 'gateway.jsonl.gz'), rows);
    // Preserve the audited frozen ranking rows byte-for-byte; no BM25 rerun occurs here.
    await copyFile(
      resolve(baselineDir, 'bm25.jsonl.gz'),
      resolve(outputDir, 'bm25.jsonl.gz'),
    );
    await atomicJson(resolve(outputDir, 'manifest.json'), manifest);
    await rename(
      resolve(outputDir, 'progress.json'),
      resolve(outputDir, 'progress.completed.json'),
    ).catch(() => {});
    console.log(
      `completed ${rows.length} queries; indexed Hit@1 ${summary.gateway.hit1.toFixed(4)}, frozen BM25 Hit@1 ${summary.bm25.hit1.toFixed(4)}; output ${outputDir}`,
    );
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
    console.error(
      'Usage: node benchmark/indexed-retrieval.mjs <normalized-dataset.json> <frozen-public-v9-dir> <output-dir>',
    );
    process.exitCode = 2;
  } else
    main(
      resolve(process.argv[2]),
      resolve(process.argv[3]),
      resolve(process.argv[4]),
    ).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
}
