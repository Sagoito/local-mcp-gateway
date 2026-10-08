import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandEnv, loadConfig, saveConfig } from '../src/config.js';

test('expands variables and does not expose missing values', () => {
  process.env.LOCAL_MCP_TEST_TOKEN = 'secret-value';
  assert.equal(expandEnv('Bearer ${LOCAL_MCP_TEST_TOKEN}'), 'Bearer secret-value');
  assert.throws(() => expandEnv('${LOCAL_MCP_MISSING}'), /LOCAL_MCP_MISSING/);
  delete process.env.LOCAL_MCP_TEST_TOKEN;
});

test('loads and saves secure stdio and HTTP configurations', async () => {
  process.env.LOCAL_MCP_TEST_TOKEN = 'secret-value';
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-config-'));
  const path = join(dir, 'nested', 'config.json');
  try {
    await saveConfig(path, { version: 1, servers: {
      worker: { command: 'node', args: ['server.js'] },
      local: { url: 'http://localhost:7777/mcp', headers: { Authorization: 'Bearer ${LOCAL_MCP_TEST_TOKEN}' } },
    } });
    const config = await loadConfig(path);
    assert.equal(config.servers.worker && 'command' in config.servers.worker ? config.servers.worker.command : '', 'node');
    assert.equal(config.servers.local && 'url' in config.servers.local ? config.servers.local.headers?.Authorization : '', 'Bearer ${LOCAL_MCP_TEST_TOKEN}');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o700);
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
  } finally { delete process.env.LOCAL_MCP_TEST_TOKEN; await rm(dir, { recursive: true, force: true }); }
});

test('rejects unsafe names, non-loopback HTTP, and URL credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-invalid-'));
  const path = join(dir, 'config.json');
  try {
    await assert.rejects(saveConfig(path, { version: 1, servers: { ['__proto__']: { command: 'x' } } } as never), /Invalid server name/);
    await assert.rejects(saveConfig(path, { version: 1, servers: { remote: { url: 'http://example.com/mcp' } } }), /must use HTTPS/);
    await assert.rejects(saveConfig(path, { version: 1, servers: { secret: { url: 'https://user:pass@example.com/mcp' } } }), /user information/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing config yields an empty version 1 config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-empty-'));
  try { assert.deepEqual(await loadConfig(join(dir, 'missing.json')), { version: 1, servers: {} }); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('config management preserves unresolved credential placeholders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-placeholder-'));
  const path = join(dir, 'config.json');
  try {
    delete process.env.LOCAL_MCP_CONFIG_TEST_SECRET;
    const original = { version: 1 as const, servers: { remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${LOCAL_MCP_CONFIG_TEST_SECRET}' } } } };
    await saveConfig(path, original);
    const loaded = await loadConfig(path);
    assert.equal(loaded.servers.remote && 'url' in loaded.servers.remote ? loaded.servers.remote.headers?.Authorization : '', 'Bearer ${LOCAL_MCP_CONFIG_TEST_SECRET}');
    await saveConfig(path, loaded);
    assert.equal((await readFile(path, 'utf8')).includes('${LOCAL_MCP_CONFIG_TEST_SECRET}'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
