#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip, gzipSync, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { evaluateRanking, macroMetrics } from './public-retrieval.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = resolve(HERE, '..');
const RETRY_CONCURRENCY = 3;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const parseGzipJsonl = (bytes) =>
  gunzipSync(bytes)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function directoryHashes(dir, prefix = '') {
  const hashes = {};
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, 'en'),
  )) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      Object.assign(
        hashes,
        await directoryHashes(resolve(dir, entry.name), name),
      );
    else if (entry.isFile())
      hashes[name] = sha256(await readFile(resolve(dir, entry.name)));
  }
  return hashes;
}

function runnerConfig(data) {
  return {
    protocol: 'MCP SDK Client/Server over InMemoryTransport',
    server: 'public',
    search: { includeSchema: false, limit: 10 },
    warmup: {
      count: 10,
      fixedQueries: data.queries.slice(0, 10).map((q) => q.id),
    },
    baseline: {
      name: 'BM25',
      k1: 1.2,
      b: 0.75,
      idf: 'log(1+(N-df+0.5)/(df+0.5))',
      tokenizer: 'lowercase [a-z0-9]+',
      document: 'name + description',
      tieBreak: 'alphabetic name then id',
    },
    metrics:
      'macro; gains are linear; DCG gain/log2(rank+1); precision denominator is cutoff k; completeness@k is 1 iff every relevant item is within k; retained query text is represented by SHA-256 only',
    datasets: { tools: data.tools.length, queries: data.queries.length },
  };
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function groupSummary(rows) {
  const result = {};
  for (const field of ['category', 'source']) {
    result[field] = {};
    const groups = new Map();
    for (const row of rows) {
      const label = row[field] ?? '(unspecified)';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(row);
    }
    for (const [label, group] of groups)
      result[field][label] = {
        ...macroMetrics(group),
        errors: group.filter((row) => row.error).length,
      };
  }
  return result;
}
function assertRows(rows, queries, toolIds, label) {
  if (rows.length !== queries.length)
    throw new Error(`${label}: row count mismatch`);
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i],
      query = queries[i];
    if (row.queryId !== query.id || row.querySha256 !== sha256(query.query))
      throw new Error(`${label}: query identity/hash mismatch at ${i}`);
    if (JSON.stringify(row.qrels) !== JSON.stringify(query.relevance))
      throw new Error(`${label}: qrels mismatch for ${query.id}`);
    if (
      !Array.isArray(row.ranking) ||
      row.ranking.length > 10 ||
      row.ranking.some((id) => !toolIds.has(id)) ||
      new Set(row.ranking).size !== row.ranking.length
    )
      throw new Error(
        `${label}: invalid or unknown ranking IDs for ${query.id}`,
      );
    if (ids.has(row.queryId))
      throw new Error(`${label}: duplicate query ID ${row.queryId}`);
    ids.add(row.queryId);
    if (
      JSON.stringify(evaluateRanking(row.ranking, query.relevance)) !==
      JSON.stringify(row.metrics)
    )
      throw new Error(`${label}: metrics mismatch for ${query.id}`);
    if (typeof row.runtimeMs !== 'number' || !Number.isFinite(row.runtimeMs))
      throw new Error(`${label}: missing runtime for ${query.id}`);
  }
}
function runChild(inputPath, outputDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [resolve(HERE, 'public-retrieval.mjs'), inputPath, outputDir],
      { cwd: ROOT, stdio: 'inherit' },
    );
    child.once('error', rejectPromise);
    child.once('close', (code, signal) =>
      resolvePromise({ code, signal: signal ?? null }),
    );
  });
}
async function writeGzipJsonl(path, rows) {
  const temp = `${path}.tmp`;
  await pipeline(
    (async function* () {
      for (const row of rows) yield `${JSON.stringify(row)}\n`;
    })(),
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(temp),
  );
  await rename(temp, path);
}

async function main(datasetPath, targetDir) {
  const datasetBytes = await readFile(datasetPath);
  const datasetHash = sha256(datasetBytes);
  const data = JSON.parse(datasetBytes.toString('utf8'));
  if (
    !Array.isArray(data.tools) ||
    !Array.isArray(data.queries) ||
    !data.metadata
  )
    throw new Error('Invalid normalized dataset');
  const target = resolve(targetDir);
  const retryScriptHash = sha256(
    await readFile(fileURLToPath(import.meta.url)),
  );
  const distFilesBefore = await directoryHashes(resolve(ROOT, 'dist'));
  const oldManifestBytes = await readFile(resolve(target, 'manifest.json'));
  const oldManifest = JSON.parse(oldManifestBytes.toString('utf8'));
  if (oldManifest.hashes?.datasetSha256 !== datasetHash)
    throw new Error(
      'Target manifest dataset hash does not match requested dataset',
    );
  const prefixCount = oldManifest.sequentialPrefix?.queries;
  const workerCount = oldManifest.config?.execution?.workers;
  if (!Number.isInteger(prefixCount) || prefixCount < 0 || workerCount !== 8)
    throw new Error(
      'Expected an eight-worker attempt with a recorded sequential prefix',
    );
  const baseConfig = runnerConfig(data);
  if (
    JSON.stringify({ ...oldManifest.config, execution: undefined }) !==
    JSON.stringify({ ...baseConfig, execution: undefined })
  )
    throw new Error('Original run config differs from frozen runner protocol');

  const oldGatewayBytes = await readFile(resolve(target, 'gateway.jsonl.gz'));
  const oldBm25Bytes = await readFile(resolve(target, 'bm25.jsonl.gz'));
  const oldGatewayRows = parseGzipJsonl(oldGatewayBytes),
    oldBm25Rows = parseGzipJsonl(oldBm25Bytes);
  if (
    oldGatewayRows.length !== data.queries.length ||
    oldBm25Rows.length !== data.queries.length
  )
    throw new Error('Original aggregate does not contain all queries');

  // Preserve the complete failed first attempt before touching aggregate outputs.
  const archivePath = resolve(target, 'infrastructure-attempt.json.gz');
  const archiveBytes = gzipSync(
    Buffer.from(
      JSON.stringify({
        manifest: oldManifest,
        gatewayRows: oldGatewayRows,
        bm25Rows: oldBm25Rows,
      }),
    ),
    { level: 9, mtime: 0 },
  );
  try {
    await writeFile(archivePath, archiveBytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existingArchive = await readFile(archivePath);
    if (sha256(existingArchive) !== sha256(archiveBytes))
      throw new Error(
        'An existing infrastructure archive differs; refusing to overwrite it',
        { cause: error },
      );
  }
  const archiveHash = sha256(archiveBytes);

  const remaining = data.queries.slice(prefixCount);
  const partitions = Array.from({ length: workerCount }, () => []);
  remaining.forEach((query, i) => partitions[i % workerCount].push(query));
  const failedReports = oldManifest.shards.filter(
    (report) =>
      report.executionDone !== true ||
      report.validation?.passed !== true ||
      Boolean(report.readError),
  );
  if (!failedReports.length)
    throw new Error(
      'No failed initial shards were reported; refusing unnecessary retries',
    );
  const failedIds = new Set(failedReports.map((report) => report.shard));
  const toolIds = new Set(data.tools.map((tool) => tool.id));
  const shardMeta = failedReports.map((report) => {
    if (
      !Number.isInteger(report.shard) ||
      report.shard < 1 ||
      report.shard > workerCount
    )
      throw new Error(`Invalid original shard number ${report.shard}`);
    const index = report.shard - 1;
    const queries = partitions[index];
    const shardData = { metadata: data.metadata, tools: data.tools, queries };
    const shardBytes = Buffer.from(JSON.stringify(shardData));
    if (sha256(shardBytes) !== report.inputSha256)
      throw new Error(
        `Reconstructed shard ${report.shard} input hash differs from original attempt`,
      );
    return { report, index, queries, shardBytes, shardData };
  });

  const rootHashes = oldManifest.hashes?.distFilesBefore;
  const runnerHash = oldManifest.hashes?.originalRunnerSha256;
  if (!rootHashes || !runnerHash)
    throw new Error('Original manifest lacks frozen runner/dist hashes');
  if (JSON.stringify(rootHashes) !== JSON.stringify(distFilesBefore))
    throw new Error(
      'Current gateway dist does not match the frozen original run',
    );
  const retryInputRoot = resolve(
    ROOT,
    '.local',
    'public-retry-inputs',
    randomUUID(),
  );
  await mkdir(retryInputRoot, { recursive: true });
  const attemptReports = [];
  let next = 0;
  async function retryWorker() {
    while (next < shardMeta.length) {
      const task = shardMeta[next++];
      const shardName = `shard-${String(task.report.shard).padStart(2, '0')}`;
      const attemptDir = resolve(target, shardName, 'retry-attempt-01');
      const retryInput = resolve(
        retryInputRoot,
        `shard-${String(task.report.shard).padStart(2, '0')}.json`,
      );
      await mkdir(attemptDir, { recursive: true });
      await writeFile(retryInput, task.shardBytes);
      const outcome = await runChild(retryInput, attemptDir);
      if (outcome.code !== 0)
        throw new Error(
          `Retry shard ${task.report.shard} exited ${outcome.code} (${outcome.signal ?? 'no signal'})`,
        );
      const manifestBytes = await readFile(
        resolve(attemptDir, 'manifest.json'),
      );
      const childManifest = JSON.parse(manifestBytes.toString('utf8'));
      const expectedConfig = runnerConfig(task.shardData);
      if (childManifest.hashes?.datasetSha256 !== sha256(task.shardBytes))
        throw new Error(
          `Retry shard ${task.report.shard}: dataset hash mismatch`,
        );
      if (childManifest.hashes?.runnerSha256 !== runnerHash)
        throw new Error(
          `Retry shard ${task.report.shard}: runner hash mismatch`,
        );
      if (
        JSON.stringify(childManifest.hashes?.distFilesSha256) !==
        JSON.stringify(rootHashes)
      )
        throw new Error(
          `Retry shard ${task.report.shard}: gateway dist hash mismatch`,
        );
      if (
        JSON.stringify(childManifest.config) !==
          JSON.stringify(expectedConfig) ||
        childManifest.hashes?.configSha256 !==
          sha256(JSON.stringify(expectedConfig))
      )
        throw new Error(
          `Retry shard ${task.report.shard}: retrieval config mismatch`,
        );
      if (
        JSON.stringify(childManifest.metadata) !== JSON.stringify(data.metadata)
      )
        throw new Error(`Retry shard ${task.report.shard}: metadata mismatch`);
      if (
        childManifest.summary?.gateway?.queries !== task.queries.length ||
        childManifest.summary?.bm25?.queries !== task.queries.length
      )
        throw new Error(
          `Retry shard ${task.report.shard}: query count mismatch`,
        );
      const gatewayBytes = await readFile(
        resolve(attemptDir, 'gateway.jsonl.gz'),
      );
      const bm25Bytes = await readFile(resolve(attemptDir, 'bm25.jsonl.gz'));
      const gatewayRows = parseGzipJsonl(gatewayBytes),
        bm25Rows = parseGzipJsonl(bm25Bytes);
      assertRows(
        gatewayRows,
        task.queries,
        toolIds,
        `retry shard ${task.report.shard} gateway`,
      );
      assertRows(
        bm25Rows,
        task.queries,
        toolIds,
        `retry shard ${task.report.shard} BM25`,
      );
      const expectedQrels = task.queries.reduce(
        (sum, query) => sum + Object.keys(query.relevance).length,
        0,
      );
      for (const rows of [gatewayRows, bm25Rows])
        if (
          rows.reduce((sum, row) => sum + Object.keys(row.qrels).length, 0) !==
          expectedQrels
        )
          throw new Error(
            `Retry shard ${task.report.shard}: qrels count mismatch`,
          );
      attemptReports.push({
        shard: task.report.shard,
        queryCount: task.queries.length,
        exitCode: outcome.code,
        manifestSha256: sha256(manifestBytes),
        inputSha256: sha256(task.shardBytes),
        files: {
          'gateway.jsonl.gz': sha256(gatewayBytes),
          'bm25.jsonl.gz': sha256(bm25Bytes),
        },
        manifest: childManifest,
        executionDone: true,
        validation: { passed: true },
      });
      task.gatewayRows = gatewayRows;
      task.bm25Rows = bm25Rows;
      console.log(
        `validated retry shard ${task.report.shard}: ${task.queries.length} queries`,
      );
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(RETRY_CONCURRENCY, shardMeta.length) },
      retryWorker,
    ),
  );

  const originalById = new Map(data.queries.map((query, i) => [query.id, i]));
  const gatewayRows = [...oldGatewayRows],
    bm25Rows = [...oldBm25Rows];
  for (const task of shardMeta) {
    const expectedQueryIds = new Set(task.queries.map((query) => query.id));
    const replacements = new Map(
      task.gatewayRows.map((row) => [row.queryId, row]),
    );
    const bm25Replacements = new Map(
      task.bm25Rows.map((row) => [row.queryId, row]),
    );
    if (
      replacements.size !== expectedQueryIds.size ||
      bm25Replacements.size !== expectedQueryIds.size
    )
      throw new Error(
        `Retry shard ${task.report.shard}: replacement query set mismatch`,
      );
    for (const queryId of expectedQueryIds) {
      if (!replacements.has(queryId) || !bm25Replacements.has(queryId))
        throw new Error(
          `Retry shard ${task.report.shard}: missing replacement ${queryId}`,
        );
      const index = originalById.get(queryId);
      gatewayRows[index] = replacements.get(queryId);
      bm25Rows[index] = bm25Replacements.get(queryId);
    }
  }
  const fullQueries = data.queries;
  assertRows(gatewayRows, fullQueries, toolIds, 'final gateway');
  assertRows(bm25Rows, fullQueries, toolIds, 'final BM25');
  for (const report of oldManifest.shards.filter(
    (item) => !failedIds.has(item.shard),
  )) {
    const queries = partitions[report.shard - 1];
    for (const query of queries) {
      const index = originalById.get(query.id);
      if (
        JSON.stringify(gatewayRows[index]) !==
          JSON.stringify(oldGatewayRows[index]) ||
        JSON.stringify(bm25Rows[index]) !== JSON.stringify(oldBm25Rows[index])
      )
        throw new Error(
          `Successful initial shard ${report.shard} row changed for ${query.id}`,
        );
    }
  }
  for (let i = 0; i < prefixCount; i++) {
    if (
      JSON.stringify(gatewayRows[i]) !== JSON.stringify(oldGatewayRows[i]) ||
      JSON.stringify(bm25Rows[i]) !== JSON.stringify(oldBm25Rows[i])
    )
      throw new Error(
        `Sequential prefix row changed for ${data.queries[i].id}`,
      );
  }

  const distFilesAfter = await directoryHashes(resolve(ROOT, 'dist'));
  if (JSON.stringify(distFilesAfter) !== JSON.stringify(distFilesBefore))
    throw new Error('Gateway dist files changed during retry recovery');

  const prefixRows = gatewayRows.slice(0, prefixCount),
    prefixBm25 = bm25Rows.slice(0, prefixCount);
  const old = oldManifest;
  const finalized = {
    ...old,
    executionDone: true,
    validation: {
      ...old.validation,
      passed: true,
      allQueriesMapped: true,
      uniqueQueryIds: new Set(gatewayRows.map((row) => row.queryId)).size,
      outputQrelsCount: gatewayRows.reduce(
        (sum, row) => sum + Object.keys(row.qrels).length,
        0,
      ),
      unknownQrelToolIds: 0,
      unknownOrDuplicateOutputIds: 0,
    },
    initialAttemptStatus: {
      executionDone: old.executionDone ?? false,
      validationPassed: old.validation?.passed ?? false,
      failedShardNumbers: failedReports.map((report) => report.shard),
      reports: old.shards,
    },
    retry: {
      concurrency: RETRY_CONCURRENCY,
      scheduling: 'up to three retry child runners concurrently',
      retriedFailedShards: shardMeta.map((task) => task.report.shard),
      retryScriptSha256: retryScriptHash,
      retryInputStorage: '.local/public-retry-inputs/<run-id>/',
      initialFailureArchive: 'infrastructure-attempt.json.gz',
      initialFailureArchiveSha256: archiveHash,
      attempts: attemptReports,
      validation: {
        gatewayDistBefore: distFilesBefore,
        gatewayDistAfter: distFilesAfter,
        unchanged: true,
        sequentialPrefixRowsUnchanged: true,
        successfulInitialShardRowsUnchanged: true,
        passed: true,
      },
      latencyInterpretation:
        'Original successful rows were measured during the eight-worker attempt; retry rows were measured with up to three retry workers. The sequential prefix retains its original single-run timings; no uncontended-host claim is made.',
    },
    summary: {
      gateway: {
        ...macroMetrics(gatewayRows),
        errors: gatewayRows.filter((row) => row.error).length,
        byCategorySource: groupSummary(gatewayRows),
      },
      bm25: {
        ...macroMetrics(bm25Rows),
        errors: bm25Rows.filter((row) => row.error).length,
        byCategorySource: groupSummary(bm25Rows),
      },
    },
    sequentialPrefix: {
      ...old.sequentialPrefix,
      gatewayErrors: prefixRows.filter((row) => row.error).length,
      gatewayRuntimeMs: {
        p50: percentile(
          prefixRows.map((row) => row.runtimeMs).filter(Number.isFinite),
          0.5,
        ),
        p95: percentile(
          prefixRows.map((row) => row.runtimeMs).filter(Number.isFinite),
          0.95,
        ),
      },
      bm25RuntimeMs: {
        p50: percentile(
          prefixBm25.map((row) => row.runtimeMs).filter(Number.isFinite),
          0.5,
        ),
        p95: percentile(
          prefixBm25.map((row) => row.runtimeMs).filter(Number.isFinite),
          0.95,
        ),
      },
    },
    initialParallelSdkRuntimeMs: old.parallelSdkRuntimeMs,
    parallelSdkRuntimeMs: {
      p50: percentile(
        gatewayRows
          .slice(prefixCount)
          .map((row) => row.runtimeMs)
          .filter(Number.isFinite),
        0.5,
      ),
      p95: percentile(
        gatewayRows
          .slice(prefixCount)
          .map((row) => row.runtimeMs)
          .filter(Number.isFinite),
        0.95,
      ),
      note: 'Mixed successful original eight-worker and up-to-three-worker retry per-query SDK times under CPU contention; not user-answer latency.',
    },
  };
  await writeGzipJsonl(resolve(target, 'gateway.jsonl.gz'), gatewayRows);
  await writeGzipJsonl(resolve(target, 'bm25.jsonl.gz'), bm25Rows);
  const manifestTemp = resolve(target, 'manifest.json.tmp');
  await writeFile(manifestTemp, JSON.stringify(finalized, null, 2) + '\n');
  await rename(manifestTemp, resolve(target, 'manifest.json'));
  console.log(
    `recovery complete: ${gatewayRows.length} original-order queries, ${failedReports.length} retried shards, errors ${finalized.summary.gateway.errors}; output ${target}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2] || !process.argv[3]) {
    console.error(
      'Usage: node benchmark/public-retry.mjs <normalized.json> <target-output-dir>',
    );
    process.exitCode = 2;
  } else {
    main(resolve(process.argv[2]), resolve(process.argv[3])).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
