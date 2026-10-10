import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAuthProvider } from '../src/auth.js';
import { createUpstreams } from '../src/upstreams.js';
import type { GatewayConfig } from '../src/types.js';

test('stdio upstream is lazy, reusable, paginated-compatible, and returns MCP result data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-connections-'));
  const config: GatewayConfig = { version: 1, servers: { issues: { command: process.execPath, args: [resolve('examples/demo-server.mjs'), 'issues'] } } };
  const upstreams = createUpstreams(config, join(dir, 'config.json'));
  try {
    const tools = await upstreams.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, 'list_issues');
    assert.equal(upstreams.getErrors()['issues'], undefined);
    const result = await upstreams.callTool('issues', 'list_issues', { state: 'open' }) as { content: Array<{ text: string }> };
    assert.match(result.content[0]?.text ?? '', /issue-1/);
    // Cached tool listing must preserve the same usable long-lived connection.
    assert.equal(await upstreams.listTools(), tools, 'cached aggregate catalogue keeps a stable identity');
  } finally {
    await upstreams.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('upstream failures are sanitized and do not reveal transport details', async () => {
  const upstreams = createUpstreams({ version: 1, servers: { secret: { command: '/no/such/private-command-123' } } }, '/tmp/local-mcp-test/config.json');
  try {
    assert.deepEqual(await upstreams.listTools(), []);
    assert.match(upstreams.getErrors().secret ?? '', /stdio upstream/);
    assert.doesNotMatch(upstreams.getErrors().secret ?? '', /private-command-123/);
  } finally { await upstreams.close(); }
});

test('call policy rejects disallowed, oversized, aborted, and unknown calls before connecting', async () => {
  const upstreams = createUpstreams({ version: 1, servers: { guarded: { command: '/no/such/private-command', allowedTools: ['permitted'] } } }, '/tmp/local-mcp-test/config.json');
  try {
    await assert.rejects(upstreams.callTool('guarded', 'not-listed', {}), /not allowed/);
    await assert.rejects(upstreams.callTool('guarded', 'permitted', { payload: 'x'.repeat(65 * 1024) }), /size limit/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(upstreams.callTool('guarded', 'permitted', {}, controller.signal), /cancelled/);
    await assert.rejects(upstreams.callTool('missing', 'permitted', {}), /Unknown upstream/);
    assert.deepEqual(upstreams.getErrors(), {});
  } finally { await upstreams.close(); }
});

test('discovery filters the allowlist and denied calls never reach the stdio tool handler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-policy-'));
  const marker = join(dir, 'calls.log');
  const upstreams = createUpstreams({ version: 1, servers: { guarded: {
    command: process.execPath, args: [resolve('examples/discovery-fixture.mjs'), '2', 'normal', marker], allowedTools: ['tool1'],
  } } }, join(dir, 'config.json'));
  try {
    assert.deepEqual((await upstreams.listTools()).map(tool => tool.name), ['tool1']);
    await assert.rejects(upstreams.callTool('guarded', 'tool2', {}), /not allowed/);
    await upstreams.callTool('guarded', 'tool1', {});
    assert.equal(await readFile(marker, 'utf8'), 'LIST\nLIST\nCALL:tool1\n');
  } finally { await upstreams.close(); await rm(dir, { recursive: true, force: true }); }
});

test('discovery rejects oversized metadata and repeated pagination cursors as a whole', async () => {
  for (const [mode, limits, reason] of [
    ['oversized', { maxToolBytes: 1024 }, /per-tool metadata limit/],
    ['repeat-cursor', { maxPages: 4 }, /repeated pagination cursor/],
    ['duplicate', {}, /duplicate or invalid tool name/],
    ['invalid-name', {}, /duplicate or invalid tool name/],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'local-mcp-discovery-limit-'));
    const upstreams = createUpstreams({ version: 1, limits, servers: { fixture: {
      command: process.execPath, args: [resolve('examples/discovery-fixture.mjs'), '2', mode],
    } } }, join(dir, 'config.json'));
    try {
      assert.deepEqual(await upstreams.listTools(), []);
      assert.match(upstreams.getErrors().fixture ?? '', reason);
    } finally { await upstreams.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('aggregate limits include cached servers when a failed listing is refreshed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-mixed-cache-'));
  const upstreams = createUpstreams({ version: 1, limits: { maxTools: 1 }, servers: {
    a_cached: { command: process.execPath, args: [resolve('examples/discovery-fixture.mjs'), '1', 'normal'] },
    b_fresh: { command: process.execPath, args: [resolve('examples/discovery-fixture.mjs'), '1', 'fail-first'] },
  } }, join(dir, 'config.json'));
  try {
    assert.deepEqual((await upstreams.listTools()).map(tool => tool.server), ['a_cached']);
    assert.match(upstreams.getErrors().b_fresh ?? '', /stdio upstream/);
    assert.deepEqual((await upstreams.listTools()).map(tool => tool.server), ['a_cached']);
    assert.match(upstreams.getErrors().b_fresh ?? '', /aggregate catalogue limit exceeded/);
  } finally { await upstreams.close(); await rm(dir, { recursive: true, force: true }); }
});

test('aggregate UTF-8 metadata budget is admitted in server-name order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-byte-budget-'));
  const upstreams = createUpstreams({ version: 1, limits: { maxCatalogBytes: 1024 }, servers: {
    a_first: { command: process.execPath, args: [resolve('examples/discovery-fixture.mjs'), '1', 'medium'] },
    b_second: { command: process.execPath, args: [resolve('examples/discovery-fixture.mjs'), '1', 'medium'] },
  } }, join(dir, 'config.json'));
  try {
    assert.deepEqual((await upstreams.listTools()).map(tool => tool.server), ['a_first']);
    assert.match(upstreams.getErrors().b_second ?? '', /aggregate catalogue limit exceeded/);
  } finally { await upstreams.close(); await rm(dir, { recursive: true, force: true }); }
});

test('raw denied tools and page counts cannot bypass configured discovery limits', async () => {
  for (const [limits, expectedReason] of [
    [{maxTools:1}, /tool count limit exceeded/],
    [{maxPages:1}, /page limit exceeded/],
  ] as const) {
    const upstreams=createUpstreams({version:1,limits,servers:{fixture:{
      command:process.execPath,args:[resolve('examples/discovery-fixture.mjs'),'2','normal'],allowedTools:['tool1'],
    }}}, '/tmp/local-mcp-test/config.json');
    try {
      assert.deepEqual(await upstreams.listTools(),[]);
      assert.match(upstreams.getErrors().fixture ?? '',expectedReason);
    } finally {await upstreams.close();}
  }
});

test('an explicit tool cap permits a live catalogue above the 5000-tool default', async () => {
  for (const [limits, count] of [[undefined,0],[{maxTools:6000},5001]] as const) {
    const upstreams=createUpstreams({version:1,limits,servers:{fixture:{
      command:process.execPath,args:[resolve('examples/discovery-fixture.mjs'),'5001','normal'],
    }}}, '/tmp/local-mcp-test/config.json');
    try {
      const tools=await upstreams.listTools();
      assert.equal(tools.length,count);
      if(count===0) assert.match(upstreams.getErrors().fixture ?? '',/tool count limit exceeded/);
      else {assert.equal(upstreams.getErrors().fixture,undefined);assert.equal(await upstreams.listTools(),tools);}
    } finally {await upstreams.close();}
  }
});

test('unchanged catalogue refresh retains array identity without extending cache TTL on hits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-refresh-'));
  const marker = join(dir, 'calls.log');
  const upstreams = createUpstreams({ version: 1, servers: { fixture: {
    command: process.execPath, args: [resolve('examples/discovery-fixture.mjs'), '1', 'normal', marker],
  } } }, join(dir, 'config.json'));
  const originalNow = Date.now;
  try {
    let now = originalNow();
    Date.now = () => now;
    const first = await upstreams.listTools();
    now += 20_000;
    assert.equal(await upstreams.listTools(), first);
    now += 11_000;
    const refreshed = await upstreams.listTools();
    assert.equal(refreshed, first);
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').filter(line => line === 'LIST').length, 2);
  } finally { Date.now = originalNow; await upstreams.close(); await rm(dir, { recursive: true, force: true }); }
});

test('OAuth state is durable with restricted permissions and bound to endpoint and config path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-auth-'));
  const configPath = join(dir, 'config.json');
  try {
    const config = { url: 'https://one.example/mcp', oauth: { clientId: 'gateway-client' } } as const;
    const provider = createAuthProvider('remote', config, configPath);
    const state = await provider.state?.();
    assert.ok(state);
    assert.equal(await provider.state?.(), state);
    await provider.saveTokens({ access_token: 'test-access', token_type: 'Bearer', refresh_token: 'test-refresh' });
    const authDir = join(dir, '.local-mcp-auth');
    const files = await import('node:fs/promises').then(fs => fs.readdir(authDir));
    assert.equal(files.length, 1);
    const mode = (await stat(join(authDir, files[0]!))).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal((await createAuthProvider('remote', config, configPath).tokens())?.access_token, 'test-access');
    assert.equal(await createAuthProvider('remote', { ...config, url: 'https://two.example/mcp' }, configPath).tokens(), undefined);
    assert.equal(await createAuthProvider('remote', config, join(dir, 'other', 'config.json')).tokens(), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
