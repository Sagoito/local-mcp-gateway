#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getEncoding } from 'js-tiktoken';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.resolve(process.argv[2] ?? path.join(root, 'dist/cli.js'));
const fixture = path.join(root, 'examples/demo-server.mjs');
const node = process.execPath;
const repetitions = positiveInt(process.env.WEB_SERVICE_CALLS, 100);
const startupTrials = positiveInt(process.env.WEB_SERVICE_STARTUPS, 5);
const warmups = positiveInt(process.env.WEB_SERVICE_WARMUPS, 10);
const args = {
  call: {
    server: 'fixture',
    tool: 'get_build',
    args: { id: 'web-service-benchmark' },
  },
};
const modes = ['legacy-stdio', 'service-http', 'thinstdio-bridge'];
const latency = Object.fromEntries(modes.map((mode) => [mode, []]));
const startup = Object.fromEntries(modes.map((mode) => [mode, []]));
const secondAgent = { legacy: [], service: [], bridge: [] };
const toolDocs = {};
let temp;

try {
  temp = await mkdtemp(path.join(os.tmpdir(), 'local-mcp-web-measure-'));
  for (let trial = 0; trial < startupTrials; trial++) {
    for (const mode of shuffle([...modes])) {
      const scope = path.join(temp, `${trial}-${mode}`);
      const configPath = path.join(scope, 'config.json');
      await mkdir(scope, { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          servers: { fixture: { command: node, args: [fixture, 'builds'] } },
          inlineTools: [],
          security: { allowCode: false },
        }),
      );
      let serviceProcess;
      const client = new Client({
        name: 'web-service-measurement',
        version: '1.0.0',
      });
      let transport;
      try {
        const started = performance.now();
        if (mode === 'legacy-stdio') {
          transport = new StdioClientTransport({
            command: node,
            args: [cliPath, '--config', configPath, 'serve'],
            stderr: 'ignore',
          });
        } else {
          serviceProcess = spawnWebService(configPath);
          await serviceProcess.ready;
          const connectionFile = `${configPath}.service.json`;
          if (mode === 'service-http') {
            const connection = JSON.parse(
              await readFile(connectionFile, 'utf8'),
            );
            transport = new StreamableHTTPClientTransport(
              new URL(connection.url),
              {
                requestInit: {
                  headers: { Authorization: `Bearer ${connection.token}` },
                },
              },
            );
          } else {
            transport = new StdioClientTransport({
              command: node,
              args: [cliPath, 'connect', '--connection-file', connectionFile],
              stderr: 'ignore',
            });
          }
        }
        await client.connect(transport, { signal: AbortSignal.timeout(30000) });
        const listed = await client.listTools(
          {},
          { signal: AbortSignal.timeout(30000) },
        );
        startup[mode].push(performance.now() - started);
        toolDocs[mode] = JSON.stringify(listed.tools);
        for (let i = 0; i < warmups; i++) await invoke(client);
        if (mode === 'service-http') {
          const before = performance.now();
          const second = await connectHttp(configPath);
          secondAgent.service.push(performance.now() - before);
          if (JSON.stringify(second.tools) !== toolDocs[mode])
            throw new Error(
              'Second service client received different tool definitions',
            );
          await second.client.close().catch(() => {});
          await second.transport.close().catch(() => {});
          const bridgeBefore = performance.now();
          const secondBridge = await connectBridge(configPath);
          secondAgent.bridge.push(performance.now() - bridgeBefore);
          if (JSON.stringify(secondBridge.tools) !== toolDocs[mode])
            throw new Error(
              'Second bridge client received different tool definitions',
            );
          await secondBridge.client.close().catch(() => {});
          await secondBridge.transport.close().catch(() => {});
        } else if (mode === 'legacy-stdio') {
          const before = performance.now();
          const second = await connectStdio(configPath);
          secondAgent.legacy.push(performance.now() - before);
          if (JSON.stringify(second.tools) !== toolDocs[mode])
            throw new Error(
              'Independent legacy client received different tool definitions',
            );
          await second.client.close().catch(() => {});
          await second.transport.close().catch(() => {});
        }
        for (let i = 0; i < repetitions; i++) {
          const before = performance.now();
          const result = await invoke(client);
          latency[mode].push({ elapsedMs: performance.now() - before, result });
        }
      } finally {
        await client.close().catch(() => {});
        await transport?.close().catch(() => {});
        await stopProcess(serviceProcess?.child);
      }
    }
  }
  const outputs = modes.map(
    (mode) => new Set(latency[mode].map((row) => JSON.stringify(row.result))),
  );
  if (
    outputs.some((values) => values.size !== 1) ||
    outputs.some((values) => !outputs[0].has([...values][0]))
  ) {
    throw new Error('Modes returned different execute outputs');
  }
  const definitions = new Set(Object.values(toolDocs));
  if (definitions.size !== 1)
    throw new Error('MCP tool definitions differ across modes');
  const toolsJsonBytes = Buffer.byteLength(toolDocs[modes[0]]);
  const toolTokens = getEncoding('o200k_base').encode(
    toolDocs[modes[0]],
  ).length;
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    protocol:
      'MCP SDK client; persistent session per trial; one deterministic upstream tool',
    counts: {
      startupTrials,
      callsPerMode: latency[modes[0]].length,
      warmupsPerTrial: warmups,
      secondAgentTrialsPerComparison: startupTrials,
    },
    fixture:
      'get_build({id:"web-service-benchmark"}) via local stdio MCP fixture',
    toolDefinitions: {
      identical: true,
      jsonBytes: toolsJsonBytes,
      o200kTokens: toolTokens,
    },
    modes: Object.fromEntries(
      modes.map((mode) => [
        mode,
        {
          startupMs: summarize(startup[mode]),
          warmExecuteCallMs: summarize(
            latency[mode].map((row) => row.elapsedMs),
          ),
        },
      ]),
    ),
    secondAgentConnectAndListToolsMs: {
      existingService: summarize(secondAgent.service),
      existingServiceViaThinStdioBridge: summarize(secondAgent.bridge),
      independentLegacyGateway: summarize(secondAgent.legacy),
    },
    result: [...outputs[0]][0],
    caveats: [
      'Loopback synthetic fixture; no real OAuth or network upstream.',
      'No model inference or agent quality is measured.',
      'Every cold path includes a spawned CLI process. HTTP and bridge share the spawned web service.',
      'The second service agent joins a live backend; the legacy comparison starts an independent gateway and upstream fixture process.',
      'These are gateway transport variants, not direct-upstream MCP comparisons.',
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
}

async function invoke(client) {
  return client.callTool({ name: 'execute', arguments: args });
}

function spawnWebService(configPath) {
  const child = spawn(
    node,
    [cliPath, '--config', configPath, 'web', '--port', '0'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let diagnostics = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Service startup timed out: ${diagnostics}`)),
      30000,
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match =
        /Weftly dashboard: (http:\/\/127\.0\.0\.1:\d+)\/#token=/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`Web service exited before ready (${code}): ${diagnostics}`),
      );
    });
  });
  return { child, ready };
}

async function connectHttp(configPath) {
  const connection = JSON.parse(
    await readFile(`${configPath}.service.json`, 'utf8'),
  );
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  return connectClient(transport);
}

function connectStdio(configPath) {
  const transport = new StdioClientTransport({
    command: node,
    args: [cliPath, '--config', configPath, 'serve'],
    stderr: 'ignore',
  });
  return connectClient(transport);
}

function connectBridge(configPath) {
  const transport = new StdioClientTransport({
    command: node,
    args: [
      cliPath,
      'connect',
      '--connection-file',
      `${configPath}.service.json`,
    ],
    stderr: 'ignore',
  });
  return connectClient(transport);
}

async function connectClient(transport) {
  const client = new Client({
    name: 'web-service-second-agent',
    version: '1.0.0',
  });
  try {
    await client.connect(transport, { signal: AbortSignal.timeout(30000) });
    const listed = await client.listTools(
      {},
      { signal: AbortSignal.timeout(30000) },
    );
    return { client, transport, tools: listed.tools };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timeout);
}

function positiveInt(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1)
    throw new Error('Trial counts must be positive integers');
  return n;
}

function shuffle(values) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return {
    n: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    medianMs: percentile(0.5),
  };
}
