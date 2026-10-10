#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value);
const GENERAL_QUERIES = ['search', 'read', 'create', 'list', 'calendar', 'file', 'weather', 'database', 'tool', 'user'];

async function directoryHashes(dir, prefix = '') {
  const hashes = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(hashes, await directoryHashes(resolve(dir, item.name), relative));
    else if (item.isFile()) hashes[relative] = sha256(await readFile(resolve(dir, item.name)));
  }
  return hashes;
}
function memory() {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external, arrayBuffersBytes: usage.arrayBuffers };
}
function osPeakRssBytes() { return process.resourceUsage().maxRSS * 1024; }
async function forceGc() {
  if (typeof global.gc !== 'function') throw new Error('Memory measurements require --expose-gc');
  for (let i = 0; i < 3; i++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
}
function toolEntry(tool) {
  return { server: 'public', name: tool.name, description: tool.description, inputSchema: { type: 'object', properties: {} } };
}
function timedSearch(index, options) {
  const start = performance.now();
  const result = index.search(options);
  return { elapsedMs: performance.now() - start, matched: result.matched, resultCount: result.tools.length };
}

async function measureChild(datasetPath, requestedTools) {
  if (typeof global.gc !== 'function') throw new Error('Child must be launched with --expose-gc');
  const startedAt = new Date().toISOString();
  let inputBytes = await readFile(datasetPath);
  const datasetSha256 = sha256(inputBytes);
  let normalized = JSON.parse(inputBytes.toString('utf8'));
  if (!Array.isArray(normalized.tools) || normalized.tools.length < requestedTools) throw new Error(`Dataset has fewer than ${requestedTools} tools`);
  let tools = normalized.tools.slice(0, requestedTools).map(toolEntry);
  const corpusSha256 = sha256(JSON.stringify(tools));
  const normalizedToolCount = normalized.tools.length;
  const searchModule = await import(pathToFileURL(resolve(ROOT, 'dist/search.js')).href);
  if (typeof searchModule.createSearchIndex !== 'function') throw new Error('dist/search.js does not export createSearchIndex');
  // Drop the full query collection, unselected tools, parsed metadata, and input byte buffer
  // before establishing the pre-index baseline. This run measures the retained catalog plus index.
  normalized = null;
  inputBytes = null;
  await forceGc();
  const beforeIndex = { memory: memory(), osPeakRssBytes: osPeakRssBytes() };

  const buildStart = performance.now();
  const index = searchModule.createSearchIndex(tools);
  const indexBuildMs = performance.now() - buildStart;
  await forceGc();
  const afterIndexGc = { memory: memory(), osPeakRssBytes: osPeakRssBytes() };
  const retainedDelta = Object.fromEntries(['rssBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes'].map(key =>
    [key, afterIndexGc.memory[key] - beforeIndex.memory[key]]));

  const exactTool = tools[0];
  const browseTimings = {
    exactServerBrowse: timedSearch(index, { server: 'public', limit: 10 }),
    exactToolBrowse: timedSearch(index, { server: 'public', tool: exactTool.name, limit: 10 }),
    exactServerAndToolBrowse: timedSearch(index, { server: 'public', tool: exactTool.name, limit: 10 }),
  };
  const generalQueryTimings = GENERAL_QUERIES.map(query => ({ query, ...timedSearch(index, { query, limit: 10 }) }));
  await forceGc();
  return {
    toolCount: requestedTools,
    corpusSelection: 'deterministic first N original tools in normalized dataset order; scale diagnostic only',
    normalizedToolCount,
    corpusSha256,
    beforeIndex,
    indexBuildMs,
    afterIndexGc,
    retainedIndexDeltaAfterGc: retainedDelta,
    browseTimings,
    generalQueryTimings,
    afterWarmSearches: { memory: memory(), osPeakRssBytes: osPeakRssBytes() },
    elapsedSinceProcessStartMs: performance.now(),
    startedAt,
  };
}

function runChild(datasetPath, toolCount) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure', datasetPath, String(toolCount)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Memory child for ${toolCount} tools exited ${code}: ${stderr || stdout}`));
      try { resolvePromise(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`Could not parse ${toolCount}-tool memory child output: ${error.message}; stderr=${stderr}`)); }
    });
  });
}

async function main(datasetPath, outputPath) {
  const output = resolve(outputPath);
  try { await readFile(output); throw new Error(`Refusing to overwrite existing memory report: ${output}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const protocolPath = resolve(ROOT, 'benchmark/results/public-v10/protocol.json');
  const protocolBytes = await readFile(protocolPath);
  JSON.parse(protocolBytes.toString('utf8'));
  const datasetBytes = await readFile(datasetPath);
  const datasetSha256 = sha256(datasetBytes);
  const indexedMemoryRunnerSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const distHashesBefore = await directoryHashes(resolve(ROOT, 'dist'));
  const started = new Date().toISOString();
  // Separate child processes prevent the smaller diagnostic's index from affecting full-catalog memory.
  const measurements = [];
  for (const count of [5000, 44453]) measurements.push(await runChild(resolve(datasetPath), count));
  const distHashesAfter = await directoryHashes(resolve(ROOT, 'dist'));
  if (stable(distHashesBefore) !== stable(distHashesAfter)) throw new Error('Product dist changed during indexed memory diagnostic');
  if (sha256(await readFile(datasetPath)) !== datasetSha256) throw new Error('Dataset changed during indexed memory diagnostic');
  if (sha256(await readFile(fileURLToPath(import.meta.url))) !== indexedMemoryRunnerSha256) throw new Error('Memory diagnostic runner changed during measurement');
  if (sha256(await readFile(protocolPath)) !== sha256(protocolBytes)) throw new Error('Public-v10 protocol changed during indexed memory diagnostic');
  const report = {
    metadata: { benchmark: 'indexed BM25 memory and initialization diagnostic', startedAt: started, node: process.version, measures: [5000, 44453], processIsolation: 'one fresh --expose-gc Node child process per catalog size', scope: 'local product index only; no quality or ranking claim' },
    hashes: { datasetSha256, indexedMemoryRunnerSha256, publicV10ProtocolSha256: sha256(protocolBytes), distFilesBeforeSha256: distHashesBefore, distFilesAfterSha256: distHashesAfter },
    measurements,
    interpretation: {
      gc: 'Input buffers and normalized dataset references are dropped before a three-cycle explicit GC. The retained catalog entries remain live; index deltas are measured after another three-cycle GC.',
      rss: 'RSS is process-wide. OS maxRSS is a cumulative peak since process start and can include JSON parsing; pre-index and post-index peak snapshots make that scope visible.',
      allocator: 'Garbage collection releases unreachable objects, but the runtime allocator may retain pages, so RSS deltas can understate or overstate index-owned memory.',
      searches: 'Browse and ten fixed lexical-search timings are local index calls after construction. They are diagnostic warm calls, not user-facing latency or quality measurements.',
    },
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote indexed memory diagnostic for 5,000 and 44,453 tools: ${output}`);
}

if (process.argv[2] === '--measure') {
  measureChild(resolve(process.argv[3]), Number(process.argv[4])).then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) { console.error('Usage: node benchmark/indexed-memory.mjs <normalized-dataset.json> <output.json>'); process.exitCode = 2; }
  else main(resolve(process.argv[2]), resolve(process.argv[3])).catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
}
