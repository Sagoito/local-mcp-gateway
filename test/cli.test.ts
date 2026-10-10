import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const cwd = resolve(import.meta.dirname, '..');

async function cli(configPath: string, ...args: string[]) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--config', configPath, ...args],
      { cwd, env: process.env },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

test('CLI creates explicit tool allowlists and preserves them through other edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-cli-policy-'));
  const path = join(dir, 'config.json');
  try {
    let out = await cli(
      path,
      'add',
      'files',
      '--allow-tool',
      'read_text_file',
      '--allow-tool',
      'search_files',
      '--',
      'node',
      'server.mjs',
    );
    assert.equal(out.code, 0, out.stderr);
    out = await cli(
      path,
      'add',
      'disabled-tools',
      '--no-tools',
      '--url',
      'https://example.test/mcp',
    );
    assert.equal(out.code, 0, out.stderr);
    out = await cli(
      path,
      'add',
      'ambiguous',
      '--no-tools',
      '--allow-tool',
      'read',
      '--',
      'node',
    );
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /not both/);
    out = await cli(path, 'remove', 'disabled-tools');
    assert.equal(out.code, 0, out.stderr);
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(config.servers.files.allowedTools, [
      'read_text_file',
      'search_files',
    ]);
    assert.equal('ambiguous' in config.servers, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config may be parsed before the upstream -- boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-cli-boundary-'));
  const configPath = join(dir, 'config.json');
  try {
    const result = await cli(
      configPath,
      'add',
      'worker',
      '--',
      'echo',
      '--config',
      'upstream-value',
    );
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.servers.worker, {
      command: 'echo',
      args: ['--config', 'upstream-value'],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP credential placeholders survive add, remove, and list without secret output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-cli-secrets-'));
  const configPath = join(dir, 'config.json');
  const secret = 'do-not-print-this-value';
  try {
    let result = await cli(
      configPath,
      'add',
      'remote',
      '--url',
      'https://example.com/mcp',
      '--header',
      'Authorization=Bearer ${CLI_TEST_SECRET}',
    );
    assert.equal(result.code, 0, result.stderr);
    let raw = await readFile(configPath, 'utf8');
    assert.match(raw, /\$\{CLI_TEST_SECRET\}/);
    assert.doesNotMatch(raw, new RegExp(secret));

    result = await cli(
      configPath,
      'add',
      'worker',
      '--env',
      `TOKEN=${secret}`,
      '--',
      'node',
      'worker.js',
      secret,
    );
    assert.equal(result.code, 0, result.stderr);
    result = await cli(configPath, 'list');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /remote\tenabled\thttp https:\/\/example\.com/);
    assert.match(result.stdout, /worker\tenabled\tstdio node/);
    assert.doesNotMatch(
      result.stdout,
      /worker\.js|do-not-print-this-value|CLI_TEST_SECRET|Authorization/,
    );

    result = await cli(configPath, 'remove', 'remote');
    assert.equal(result.code, 0, result.stderr);
    raw = await readFile(configPath, 'utf8');
    assert.doesNotMatch(raw, /CLI_TEST_SECRET/);
    assert.match(raw, /do-not-print-this-value/); // still belongs to the configured stdio env and args
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('init is idempotent and invalid options fail clearly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-cli-init-'));
  const configPath = join(dir, 'config.json');
  try {
    let result = await cli(configPath, 'init');
    assert.equal(result.code, 0, result.stderr);
    const first = await readFile(configPath, 'utf8');
    result = await cli(configPath, 'init');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')),
      JSON.parse(first),
    );
    result = await cli(configPath, 'list', '--unknown');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown option/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('add refuses to overwrite an existing server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-cli-duplicate-'));
  const configPath = join(dir, 'config.json');
  try {
    let result = await cli(configPath, 'add', 'worker', '--', 'first-command');
    assert.equal(result.code, 0, result.stderr);
    result = await cli(configPath, 'add', 'worker', '--', 'second-command');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /already exists/);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.servers.worker.command, 'first-command');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removing an upstream prunes only its inline and native selections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-inline-remove-'));
  const configPath = join(dir, 'config.json');
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        servers: { a: { command: 'echo' }, b: { command: 'echo' } },
        inlineTools: [
          { server: 'a', tool: 'one' },
          { server: 'b', tool: 'two' },
        ],
        nativeTools: [
          { server: 'a', tool: 'three' },
          { server: 'b', tool: 'four' },
        ],
      }),
    );
    const result = await cli(configPath, 'remove', 'a');
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.inlineTools, [{ server: 'b', tool: 'two' }]);
    assert.deepEqual(config.nativeTools, [{ server: 'b', tool: 'four' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
