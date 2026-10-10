#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runs = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node benchmark/prepare-paged.mjs RUNS_DIR [--pairs 1..16] [--native] [--gateway-entry PATH]');
let pairs = 1, native = false, gatewayEntry;
for (let i = 3; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--native') { native = true; continue; }
  if (arg === '--pairs') {
    const value = process.argv[++i];
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 16) throw new Error('--pairs must be an integer from 1 through 16');
    pairs = Number(value); continue;
  }
  if (arg === '--gateway-entry') {
    if (!process.argv[i + 1]) throw new Error('--gateway-entry requires a path');
    gatewayEntry = path.resolve(process.argv[++i]); continue;
  }
  throw new Error(`Unknown option: ${arg}`);
}
const prepareArgs = [path.join(root, 'benchmark/prepare.mjs'), runs, '--pairs', String(pairs)];
if (native) prepareArgs.push('--native');
const prepared = spawnSync(process.execPath, prepareArgs, { cwd: root, encoding: 'utf8' });
if (prepared.status !== 0) throw new Error(prepared.stderr || `prepare.mjs exited ${prepared.status}`);

const archivePath = path.join(root, 'benchmark/results/scale-v7/catalogs.json.gz');
const archive = JSON.parse(gunzipSync(await fs.readFile(archivePath)).toString('utf8'));
const serverCount = pairs * 2;
const catalogues = new Map();
for (const mode of ['direct', 'gateway']) {
  const archiveMode = mode === 'direct' ? 'direct' : native ? 'gateway-native' : 'gateway-default';
  const catalogue = archive.cases.find(c => c.serverCount === serverCount && c.mode === archiveMode)?.definitions;
  if (!catalogue?.tools) throw new Error(`No ${archiveMode} catalogue for ${serverCount} servers in ${archivePath}`);
  const definitionJson = JSON.stringify(catalogue);
  const definitionSha256 = createHash('sha256').update(definitionJson).digest('hex');
  const pages = [[]];
  for (const tool of catalogue.tools) {
    const current = pages.at(-1);
    if (Buffer.byteLength(JSON.stringify({ tools: [tool] }), 'utf8') > 12_000) throw new Error(`Tool ${tool.name} exceeds daemon page limit`);
    if (Buffer.byteLength(JSON.stringify({ tools: [...current, tool] }), 'utf8') > 12_000) pages.push([tool]);
    else current.push(tool);
  }
  const pageGroups = Array.from({ length: Math.ceil(pages.length / 3) }, (_, i) => [i * 3, Math.min((i + 1) * 3, pages.length)]);
  catalogues.set(mode, { pages, pageGroups, definitionSha256 });
}
const ids = JSON.parse(await fs.readFile(path.join(runs, 'order.json'), 'utf8'));
for (const id of ids) {
  const dir = path.join(runs, id);
  const cfgPath = path.join(dir, 'config.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  const { pages, pageGroups, definitionSha256 } = catalogues.get(cfg.mode);
  const listing = `First list tool definitions. Fetch every catalogue page before any task calls, sequentially, and keep each page as a separate printed text block. Do not parse, filter, combine, calculate from, truncate, or transform the returned tool definitions. Use one functions.exec script per listed group, in order, with max_output_tokens:70000:\n\n${pageGroups.map(([start, end]) => `// @exec: {"max_output_tokens":70000}\nfor (let page = ${start}; page < ${end}; page++) {\n  const result = await tools.exec_command({cmd: 'node ${path.join(root, 'benchmark/bridge.mjs')} ${runs} RUN_ID list ' + page, max_output_tokens:70000});\n  text(result.output);\n}`).join('\n\n')}\n\n`;
  cfg.cataloguePageCount = pages.length;
  cfg.catalogueDeliveryGroups = pageGroups.length;
  cfg.catalogPaged = true;
  cfg.catalogueDefinitionSha256 = definitionSha256;
  if (gatewayEntry) cfg.gatewayEntry = gatewayEntry;
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  const promptPath = path.join(dir, 'prompt.txt');
  const prompt = await fs.readFile(promptPath, 'utf8');
  const start = prompt.indexOf('First list tool definitions:');
  const end = prompt.indexOf('\n\nCall an exposed tool:', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate listing instructions in ${id}`);
  const replacement = listing.replaceAll('RUN_ID', id);
  await fs.writeFile(promptPath, prompt.slice(0, start) + replacement + prompt.slice(end + 2));
}
console.log(JSON.stringify({ runs, pairs, native, catalogues: Object.fromEntries([...catalogues].map(([mode, c]) => [mode, { cataloguePageCount: c.pages.length, catalogueDeliveryGroups: c.pageGroups.length, catalogueDefinitionSha256: c.definitionSha256 }])), gatewayEntry: gatewayEntry ?? null }));
