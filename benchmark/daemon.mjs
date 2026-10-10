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
  if (typeof command !== 'string' || !Array.isArray(args) || !args.every(x => typeof x === 'string')) throw new Error('Invalid stdio server configuration');
  const client = new Client({ name: 'mcp-benchmark-harness', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])), stderr: 'ignore' });
  await timed(client.connect(transport), 60_000, 'MCP connection');
  return { client, transport };
}
async function getSession(runId) {
  const current = sessions.get(runId);
  if (current) return current;
  const runDir = path.join(RUNS_DIR, runId);
  const cfg = await readJson(path.join(runDir, 'config.json'));
  if (!['direct', 'gateway'].includes(cfg.mode)) throw new Error('Run mode must be direct or gateway');
  const session = { mode: cfg.mode, clients: new Map(), cache: null, closed: false };
  if (cfg.mode === 'direct') {
    const servers = cfg.gatewayConfig?.servers;
    if (!servers || typeof servers !== 'object' || Object.keys(servers).length !== 2 || !servers.filesystem || !servers.memory) throw new Error('Direct config requires filesystem and memory stdio servers');
    for (const name of ['filesystem', 'memory']) {
      const s = servers[name];
      session.clients.set(name, await connect(s.command, s.args ?? [], s.env ?? {}));
    }
  } else {
    if (!cfg.gatewayConfig || cfg.gatewayConfig.version !== 1 || !cfg.gatewayConfig.servers) throw new Error('Invalid gateway configuration');
    const gatewayPath = path.join(runDir, 'gateway.json');
    await atomicJson(gatewayPath, cfg.gatewayConfig);
    session.clients.set('gateway', await connect(process.execPath, [path.resolve(path.dirname(new URL(import.meta.url).pathname), '../dist/cli.js'), '--config', gatewayPath, 'serve']));
  }
  sessions.set(runId, session);
  return session;
}
async function list(session) {
  if (session.cache) return session.cache;
  const tools = [];
  if (session.mode === 'direct') {
    for (const [server, { client }] of session.clients) {
      let cursor;
      do {
        const page = await timed(client.listTools(cursor ? { cursor } : {}, { signal: AbortSignal.timeout(60_000) }), 60_000, 'listTools');
        for (const t of page.tools) tools.push({ name: `${server}__${t.name}`, description: t.description, inputSchema: t.inputSchema });
        cursor = page.nextCursor;
      } while (cursor);
    }
    tools.sort((a, b) => a.name.localeCompare(b.name));
    session.cache = { tools };
  } else {
    session.cache = await timed(session.clients.get('gateway').client.listTools({}, { signal: AbortSignal.timeout(60_000) }), 60_000, 'listTools');
  }
  return session.cache;
}
async function call(session, name, args) {
  if (typeof name !== 'string' || !name || name.length > 256) throw new Error('Invalid tool name');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
  let client = session.clients.get('gateway')?.client;
  let tool = name;
  if (session.mode === 'direct') {
    const sep = name.indexOf('__');
    const server = name.slice(0, sep);
    if (sep < 1 || !['filesystem', 'memory'].includes(server) || !name.slice(sep + 2)) throw new Error('Direct tool names must be filesystem__tool or memory__tool');
    client = session.clients.get(server).client;
    tool = name.slice(sep + 2);
  }
  return timed(client.callTool({ name: tool, arguments: args }, undefined, { signal: AbortSignal.timeout(60_000) }), 60_000, 'callTool');
}
async function closeRun(runId) {
  const session = sessions.get(runId);
  if (!session || session.closed) return;
  session.closed = true;
  await Promise.allSettled([...session.clients.values()].map(({ transport }) => transport.close()));
  sessions.delete(runId);
}
async function processRequest(file) {
  let req;
  try { req = await readJson(file); }
  catch (error) { await rename(file, `${file}.invalid`).catch(() => {}); return; }
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let result, error;
  try {
    if (!req || !safeId(req.id) || !safeId(req.runId) || !['list', 'call', 'finish'].includes(req.op)) throw new Error('Invalid request');
    const session = await getSession(req.runId);
    if (req.op === 'list') result = await list(session);
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
    const event = { id: req.id, op: req.op, name: req.name, args: req.args, answer: req.answer, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - start, ...(error ? { error } : { response: result }) };
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
