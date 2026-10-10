import assert from 'node:assert/strict';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { connectBridge, validateConnection } from '../src/bridge.js';

class MemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[] = [];
  readonly events: string[];
  protocolVersion?: string;
  closed = 0;

  constructor(
    private readonly name: string,
    events: string[] = [],
  ) {
    this.events = events;
  }
  async start(): Promise<void> {
    this.events.push(`start:${this.name}`);
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }
  async close(): Promise<void> {
    this.closed++;
    this.onclose?.();
  }
  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }
  receive(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

test('bridge starts HTTP first and forwards JSON-RPC unchanged, including initialize negotiation', async () => {
  const events: string[] = [];
  const stdio = new MemoryTransport('stdio', events);
  const http = new MemoryTransport('http', events);
  const bridge = await connectBridge({ stdio, http });
  assert.deepEqual(events, ['start:http', 'start:stdio']);

  const initialize = {
    jsonrpc: '2.0',
    id: 7,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  } as JSONRPCMessage;
  stdio.receive(initialize);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(http.sent[0], initialize);

  const response = {
    jsonrpc: '2.0',
    id: 7,
    result: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      serverInfo: { name: 'upstream', version: '1' },
    },
  } as JSONRPCMessage;
  http.receive(response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(http.protocolVersion, '2025-11-25');
  assert.equal(stdio.sent[0], response);

  const cancellation = {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 8 },
  } as JSONRPCMessage;
  stdio.receive(cancellation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(http.sent[1], cancellation);
  await bridge.close();
  assert.equal(stdio.closed, 1);
  assert.equal(http.closed, 1);
});

test('HTTP requests do not block later cancellation and notification sends', async () => {
  const stdio = new MemoryTransport('stdio');
  const http = new MemoryTransport('http');
  let finishRequest!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishRequest = resolve;
  });
  http.send = async function (message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
    if ('id' in message) await blocked;
  };
  const bridge = await connectBridge({ stdio, http });
  const request = {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {},
  } as JSONRPCMessage;
  const cancellation = {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 11 },
  } as JSONRPCMessage;
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progress: 1 },
  } as JSONRPCMessage;
  stdio.receive(request);
  stdio.receive(cancellation);
  stdio.receive(notification);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(http.sent, [request, cancellation, notification]);
  finishRequest();
  await bridge.close();
});

test('asynchronous transport errors report a sanitized error and close both sides once', async () => {
  const stdio = new MemoryTransport('stdio');
  const http = new MemoryTransport('http');
  const reported: Error[] = [];
  const bridge = await connectBridge({
    stdio,
    http,
    onError: (error) => reported.push(error),
  });
  http.onerror?.(new Error('https://user:secret@example.test?token=secret'));
  await bridge.close();
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.message, 'Bridge transport failed');
  assert.equal(stdio.closed, 1);
  assert.equal(http.closed, 1);
  stdio.onerror?.(new Error('duplicate failure'));
  assert.equal(reported.length, 1);
});

test('connection file requires strict private JSON and validates URL credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-'));
  const file = path.join(dir, 'connection.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        url: 'https://example.test/mcp',
        token: 'secret',
      }),
      { mode: 0o600 },
    );
    await chmod(file, 0o600);
    const connection = await validateConnection({ connectionFile: file });
    assert.equal(connection.url.href, 'https://example.test/mcp');
    assert.equal(connection.token, 'secret');

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        url: 'https://example.test/mcp?x=1',
        token: 'secret',
      }),
      { mode: 0o600 },
    );
    await chmod(file, 0o600);
    await assert.rejects(
      validateConnection({ connectionFile: file }),
      /Invalid bridge URL/,
    );

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        url: 'https://example.test',
        token: 'secret',
        extra: true,
      }),
      { mode: 0o600 },
    );
    await chmod(file, 0o600);
    await assert.rejects(
      validateConnection({ connectionFile: file }),
      /Invalid connection file/,
    );

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        url: 'https://example.test',
        token: 'secret',
      }),
      { mode: 0o600 },
    );
    await chmod(file, 0o644);
    if (process.platform !== 'win32')
      await assert.rejects(
        validateConnection({ connectionFile: file }),
        /Invalid connection file/,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('direct connection requires nonempty environment token and permits only loopback HTTP', async () => {
  const envName = 'LOCAL_MCP_BRIDGE_TEST_TOKEN';
  delete process.env[envName];
  await assert.rejects(
    validateConnection({ url: 'https://example.test/mcp', tokenEnv: envName }),
    /token environment variable is missing/,
  );
  process.env[envName] = 'secret';
  try {
    assert.equal(
      (
        await validateConnection({
          url: 'http://127.0.0.1:3000/mcp',
          tokenEnv: envName,
        })
      ).url.hostname,
      '127.0.0.1',
    );
    await assert.rejects(
      validateConnection({ url: 'http://example.test/mcp', tokenEnv: envName }),
      /Invalid bridge URL/,
    );
    await assert.rejects(
      validateConnection({
        url: 'https://user:password@example.test',
        tokenEnv: envName,
      }),
      /Invalid bridge URL/,
    );
  } finally {
    delete process.env[envName];
  }
});
