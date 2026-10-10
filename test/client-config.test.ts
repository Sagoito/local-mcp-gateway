import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { clientConfig } from '../src/client-config.js';

const options = {
  configPath: 'workspace with spaces/gateway.json',
  cliPath: 'installed tools/local-mcp/cli.js',
  nodePath: 'runtime/node',
};
const node = resolve(options.nodePath);
const args = [resolve(options.cliPath), '--config', resolve(options.configPath), 'serve'];

test('builds each supported client format with absolute executable and argument paths', () => {
  assert.deepEqual(clientConfig('generic', options), {
    mcpServers: { 'local-mcp': { command: node, args } },
  });
  assert.deepEqual(clientConfig('copilot', options), {
    mcpServers: { 'local-mcp': { type: 'local', command: node, args, tools: ['*'] } },
  });
  assert.deepEqual(clientConfig('vscode', options), {
    servers: { 'local-mcp': { type: 'stdio', command: node, args } },
  });
  assert.deepEqual(clientConfig('opencode', options), {
    mcp: { 'local-mcp': { type: 'local', command: [node, ...args], enabled: true } },
  });
  for (const path of [node, ...args.slice(0, 1), args[2]]) assert.equal(isAbsolute(path), true);
});

test('defaults the runtime to the current Node executable', () => {
  assert.deepEqual(clientConfig('generic', { configPath: 'gateway.json', cliPath: 'cli.js' }), {
    mcpServers: { 'local-mcp': { command: resolve(process.execPath), args: [resolve('cli.js'), '--config', resolve('gateway.json'), 'serve'] } },
  });
});

test('rejects unsupported formats and empty paths', () => {
  assert.throws(() => clientConfig('unknown' as never, options), /Unsupported client format/);
  assert.throws(() => clientConfig('generic', { ...options, cliPath: '' }), /cliPath must be a non-empty path/);
  assert.throws(() => clientConfig('generic', { ...options, configPath: '' }), /configPath must be a non-empty path/);
});
