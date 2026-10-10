#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getEncoding } from 'js-tiktoken';

const [runsArg, outArg] = process.argv.slice(2);
if (!runsArg || !outArg)
  throw Error(
    'Usage: node benchmark/quality-preflight.mjs RUNS_DIR OUTPUT_DIR',
  );
const runs = path.resolve(runsArg),
  out = path.resolve(outArg);
const enc = getEncoding('o200k_base');
const clients = new Map(),
  records = [];
const cfg = JSON.parse(
  await fs.readFile(path.join(runs, 'q1-direct-r1/config.json'), 'utf8'),
);
const fixtures = path.join(runs, 'fixtures');
async function connect(alias, command, args = [], env = {}) {
  const client = new Client({ name: 'quality-preflight', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command,
    args,
    env,
    stderr: 'ignore',
  });
  clients.set(alias, { client, transport });
  await client.connect(transport, { signal: AbortSignal.timeout(60000) });
  return client;
}
function record(label, payload) {
  const serialized = JSON.stringify(payload);
  const bytes = Buffer.byteLength(serialized),
    tokens = enc.encode(serialized).length;
  records.push({ label, bytes, tokenProxy: tokens, payload });
  if (tokens > 4500)
    throw Error(
      `${label}: ${tokens} token proxies exceeds preflight display budget`,
    );
}
async function filesUnder(dir) {
  const files = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...(await filesUnder(file)));
    else if (item.isFile() && !file.endsWith('memory.jsonl')) files.push(file);
  }
  return files.sort();
}
try {
  const all = [];
  for (const [alias, server] of Object.entries(cfg.gatewayConfig.servers)) {
    const client = await connect(
      alias,
      server.command,
      server.args,
      server.env,
    );
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    all.push(
      ...tools.map((t) => ({
        name: `${alias}__${t.name}`,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    );
  }
  all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  record('direct-definitions', { tools: all });
  const files = await filesUnder(fixtures);
  record(
    'direct-all-files',
    await clients.get('filesystem').client.callTool({
      name: 'read_multiple_files',
      arguments: { paths: files },
    }),
  );
  record(
    'direct-memory-graph',
    await clients
      .get('memory')
      .client.callTool({ name: 'read_graph', arguments: {} }),
  );
  for (const file of files)
    record(
      `direct-file:${path.relative(fixtures, file)}`,
      await clients
        .get('filesystem')
        .client.callTool({ name: 'read_text_file', arguments: { path: file } }),
    );
  record(
    'direct-missing-file',
    await clients.get('filesystem').client.callTool({
      name: 'read_text_file',
      arguments: { path: path.join(fixtures, '__preflight_missing__.json') },
    }),
  );
  record(
    'direct-metadata',
    await clients.get('filesystem').client.callTool({
      name: 'get_file_info',
      arguments: { path: files[0] },
    }),
  );
  record(
    'direct-exact-nodes',
    await clients.get('memory').client.callTool({
      name: 'open_nodes',
      arguments: { names: ['Aster Sync', 'Aster Sync Canary'] },
    }),
  );

  const gatewayCfg = JSON.parse(
    await fs.readFile(path.join(runs, 'q1-gateway-r1/config.json'), 'utf8'),
  );
  const configPath = path.join(runs, 'preflight-gateway.json');
  await fs.writeFile(configPath, JSON.stringify(gatewayCfg.gatewayConfig));
  const gateway = await connect('gateway', process.execPath, [
    gatewayCfg.gatewayEntry,
    '--config',
    configPath,
    'serve',
  ]);
  record('gateway-definitions', await gateway.listTools({}));
  const search = await gateway.callTool({
    name: 'search',
    arguments: { limit: 1 },
  });
  if (search.isError) throw Error('Gateway discovery failed');
  const discovery = JSON.parse(
    search.content.find((c) => c.type === 'text').text,
  );
  if (discovery.matched !== all.length || discovery.unavailableCount)
    throw Error('Gateway upstream catalogue is incomplete');
  record('gateway-discovery-verification', search);
  record(
    'gateway-all-files',
    await gateway.callTool({
      name: 'filesystem__read_multiple_files',
      arguments: { paths: files },
    }),
  );
  record(
    'gateway-memory-graph',
    await gateway.callTool({
      name: 'execute',
      arguments: { call: { server: 'memory', tool: 'read_graph', args: {} } },
    }),
  );
  record(
    'gateway-metadata-discovery',
    await gateway.callTool({
      name: 'search',
      arguments: {
        server: 'filesystem',
        tool: 'get_file_info',
        includeSchema: true,
      },
    }),
  );
  record(
    'gateway-exact-node-discovery',
    await gateway.callTool({
      name: 'search',
      arguments: { server: 'memory', tool: 'open_nodes', includeSchema: true },
    }),
  );
  if (
    records.some((r) => r.payload?.isError && r.label !== 'direct-missing-file')
  )
    throw Error('Unexpected preflight MCP error');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(
    path.join(out, 'preflight.json.gz'),
    gzipSync(JSON.stringify({ records })),
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    upstreamTools: all.length,
    maximumResponseTokenProxy: Math.max(...records.map((r) => r.tokenProxy)),
    responseDisplayBudgetTokenProxy: 4500,
    records: records.map((r) =>
      Object.fromEntries(
        Object.entries(r).filter(([key]) => key !== 'payload'),
      ),
    ),
    caveat:
      'SDK payload bounds plus worker clipping audits support delivery checks; these are not provider-reported context or billing.',
  };
  await fs.writeFile(
    path.join(out, 'preflight.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} finally {
  await Promise.allSettled(
    [...clients.values()].map((c) => c.transport.close()),
  );
}
