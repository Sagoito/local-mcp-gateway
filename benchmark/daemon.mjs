#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RUNS_DIR = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node benchmark/daemon.mjs RUNS_DIR');
const INBOX = path.join(RUNS_DIR, 'inbox');
const OUTBOX = path.join(RUNS_DIR, 'outbox');
const sessions = new Map();
const chains = new Map();
const inFlight = new Set();
let stopping = false;
const CONNECT_BATCH_SIZE = 4;
const MAX_DIRECT_SERVERS = 32;
const CATALOG_PAGE_BYTES = 12_000;
const MAX_CATALOG_PAGE_INDEX = 999;

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const errText = e => String(e?.message ?? e).replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]').slice(0, 2000);

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function atomicJson(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, file);
}
function timed(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
async function connect(command, args = [], env = {}) {
  if (typeof command !== 'string' || !command.trim() || !Array.isArray(args) || !args.every(x => typeof x === 'string') || !env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Invalid stdio server configuration');
  const client = new Client({ name: 'mcp-benchmark-harness', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])), stderr: 'ignore' });
  try { await timed(client.connect(transport), 60_000, 'MCP connection'); }
  catch (error) { await transport.close().catch(() => {}); throw error; }
  return { client, transport };
}
function validAlias(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name) && !name.includes('__');
}
async function closeClients(clients) {
  await Promise.allSettled([...clients.values()].map(({ transport }) => transport.close()));
  clients.clear();
}
function compareNames(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
async function getSession(runId) {
  const current = sessions.get(runId);
  if (current) return current;
  const runDir = path.join(RUNS_DIR, runId);
  const cfg = await readJson(path.join(runDir, 'config.json'));
  if (!['direct', 'gateway'].includes(cfg.mode)) throw new Error('Run mode must be direct or gateway');
  const session = { mode: cfg.mode, clients: new Map(), cache: null, catalogPages: null, closed: false };
  if (cfg.mode === 'direct') {
    const servers = cfg.gatewayConfig?.servers;
    const names = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers).sort(compareNames) : [];
    if (!names.length || names.length > MAX_DIRECT_SERVERS || names.some(name => !validAlias(name))) throw new Error(`Direct config requires 1-${MAX_DIRECT_SERVERS} nonempty safe server aliases without '__'`);
    for (const name of names) {
      const server = servers[name];
      if (!server || typeof server !== 'object' || Array.isArray(server) || typeof server.command !== 'string' || !server.command.trim() || Object.hasOwn(server, 'url')) throw new Error(`Direct server ${name} must use stdio command configuration`);
      if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(arg => typeof arg === 'string'))) throw new Error(`Direct server ${name} has invalid stdio args`);
      if (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env))) throw new Error(`Direct server ${name} has invalid stdio env`);
    }
    try {
      for (let i = 0; i < names.length; i += CONNECT_BATCH_SIZE) {
        const batch = names.slice(i, i + CONNECT_BATCH_SIZE);
        const settled = await Promise.allSettled(batch.map(async name => [name, await connect(servers[name].command, servers[name].args ?? [], servers[name].env ?? {})]));
        for (const result of settled) if (result.status === 'fulfilled') session.clients.set(...result.value);
        const failure = settled.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      }
    } catch (error) {
      await closeClients(session.clients);
      throw error;
    }
  } else {
    if (!cfg.gatewayConfig || cfg.gatewayConfig.version !== 1 || !cfg.gatewayConfig.servers) throw new Error('Invalid gateway configuration');
    const gatewayPath = path.join(runDir, 'gateway.json');
    await atomicJson(gatewayPath, cfg.gatewayConfig);
    session.clients.set('gateway', await connect(process.execPath, [cfg.gatewayEntry ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../dist/cli.js'), '--config', gatewayPath, 'serve']));
  }
  sessions.set(runId, session);
  return session;
}
async function list(session, pageIndex) {
  if (session.cache) return session.cache;
  const tools = [];
  if (session.mode === 'direct') {
    const servers = [...session.clients.entries()].sort(([a], [b]) => compareNames(a, b));
    for (let i = 0; i < servers.length; i += CONNECT_BATCH_SIZE) {
      const batchTools = await Promise.all(servers.slice(i, i + CONNECT_BATCH_SIZE).map(async ([server, { client }]) => {
        const listed = [];
        let cursor;
        do {
          const page = await timed(client.listTools(cursor ? { cursor } : {}, { signal: AbortSignal.timeout(60_000) }), 60_000, 'listTools');
          for (const tool of page.tools) listed.push({ name: `${server}__${tool.name}`, description: tool.description, inputSchema: tool.inputSchema });
          cursor = page.nextCursor;
        } while (cursor);
        return listed;
      }));
      tools.push(...batchTools.flat());
    }
    tools.sort((a, b) => compareNames(a.name, b.name));
    session.cache = { tools };
  } else {
    session.cache = await timed(session.clients.get('gateway').client.listTools({}, { signal: AbortSignal.timeout(60_000) }), 60_000, 'listTools');
  }
  return session.cache;
}
function makeCatalogPages(tools) {
  const pages = [[]];
  for (const tool of tools) {
    const current = pages.at(-1);
    const candidate = [...current, tool];
    if (Buffer.byteLength(JSON.stringify({ tools: [tool] }), 'utf8') > CATALOG_PAGE_BYTES) {
      throw new Error(`Tool ${tool.name} exceeds the ${CATALOG_PAGE_BYTES}-byte catalogue page limit`);
    }
    if (Buffer.byteLength(JSON.stringify({ tools: candidate }), 'utf8') > CATALOG_PAGE_BYTES) {
      pages.push([tool]);
    } else current.push(tool);
  }
  if (pages.length > MAX_CATALOG_PAGE_INDEX + 1) throw new Error(`Catalogue exceeds the ${MAX_CATALOG_PAGE_INDEX + 1}-page limit`);
  return pages;
}
async function listPage(session, pageIndex) {
  const catalog = await list(session);
  if (!session.catalogPages) session.catalogPages = makeCatalogPages(catalog.tools);
  if (pageIndex >= session.catalogPages.length) throw new Error(`Catalogue page ${pageIndex} is out of range (page count: ${session.catalogPages.length})`);
  return {
    tools: session.catalogPages[pageIndex],
    catalogPage: { index: pageIndex, pages: session.catalogPages.length, totalTools: catalog.tools.length, complete: true },
  };
}
async function call(session, name, args) {
  if (typeof name !== 'string' || !name || name.length > 256) throw new Error('Invalid tool name');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
  let client = session.clients.get('gateway')?.client;
  let tool = name;
  if (session.mode === 'direct') {
    const sep = name.indexOf('__');
    const server = name.slice(0, sep);
    const serverSession = session.clients.get(server);
    if (sep < 1 || !validAlias(server) || !serverSession || !name.slice(sep + 2)) throw new Error('Direct tool name must use a configured server alias and tool name');
    client = serverSession.client;
    tool = name.slice(sep + 2);
  }
  return timed(client.callTool({ name: tool, arguments: args }, undefined, { signal: AbortSignal.timeout(60_000) }), 60_000, 'callTool');
}
async function closeRun(runId) {
  const session = sessions.get(runId);
  if (!session || session.closed) return;
  session.closed = true;
  await closeClients(session.clients);
  sessions.delete(runId);
}
async function processRequest(file) {
  const claimed = `${file}.processing`;
  try { await rename(file, claimed); } catch { return; }
  file = claimed;
  let req;
  try { req = await readJson(file); }
  catch (error) { await rename(file, `${file}.invalid`).catch(() => {}); return; }
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let result, error;
  try {
    if (!req || !safeId(req.id) || !safeId(req.runId) || !['list', 'call', 'finish'].includes(req.op)) throw new Error('Invalid request');
    if (req.op === 'list') {
      if (req.page !== undefined && (!Number.isInteger(req.page) || req.page < 0 || req.page > MAX_CATALOG_PAGE_INDEX)) throw new Error(`List page must be an integer from 0 to ${MAX_CATALOG_PAGE_INDEX}`);
    } else if (req.page !== undefined) throw new Error('Page index is only valid for list requests');
    const session = await getSession(req.runId);
    if (req.op === 'list') result = req.page === undefined ? await list(session) : await listPage(session, req.page);
    else if (req.op === 'call') result = await call(session, req.name, req.args);
    else {
      const runDir = path.join(RUNS_DIR, req.runId);
      await atomicJson(path.join(runDir, 'answer.json'), { answer: req.answer, finishedAt: new Date().toISOString() });
      result = { finished: true };
      await closeRun(req.runId);
    }
  } catch (e) { error = errText(e); }
  const response = error ? { id: req?.id, error } : { id: req.id, result };
  if (safeId(req?.id)) await atomicJson(path.join(OUTBOX, `${req.id}.json`), response).catch(() => {});
  if (safeId(req?.runId)) {
    const event = { id: req.id, op: req.op, name: req.name, args: req.args, answer: req.answer, page: req.page, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - start, ...(error ? { error } : { response: result }) };
    await appendFile(path.join(RUNS_DIR, req.runId, 'events.jsonl'), `${JSON.stringify(event)}\n`).catch(() => {});
  }
  await rename(file, `${file}.done`).catch(() => {});
}
async function poll() {
  await mkdir(INBOX, { recursive: true }); await mkdir(OUTBOX, { recursive: true });
  while (!stopping) {
    const files = (await readdir(INBOX)).filter(n => n.endsWith('.json')).sort();
    for (const name of files) {
      const file = path.join(INBOX, name);
      if (inFlight.has(file)) continue;
      inFlight.add(file);
      // Each run is serialized while independent runs can progress concurrently.
      readJson(file).then(req => {
        const run = safeId(req?.runId) ? req.runId : '__invalid__';
        const prior = chains.get(run) ?? Promise.resolve();
        const next = prior.then(() => processRequest(file)).finally(() => { inFlight.delete(file); if (chains.get(run) === next) chains.delete(run); });
        chains.set(run, next);
      }).catch(() => processRequest(file).finally(() => inFlight.delete(file)));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function shutdown() {
  stopping = true;
  await Promise.allSettled([...chains.values()]);
  await Promise.allSettled([...sessions.keys()].map(closeRun));
}
process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
poll().catch(error => { console.error(`benchmark daemon: ${errText(error)}`); process.exitCode = 1; });
