import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createUpstreams } from '../src/upstreams.js';
import { login } from '../src/auth.js';
import { loadConfig, saveConfig } from '../src/config.js';

const exec = promisify(execFile);
const project = resolve(import.meta.dirname, '..');
async function cli(config: string, ...args: string[]) {
  try {
    const result = await exec(process.execPath, [join(project, 'dist/cli.js'), '--config', config, ...args], { cwd: project });
    return { code: 0, ...result };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('setup imports existing servers without launching or changing the source, and its generated entry works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-setup-'));
  const source = join(dir, 'client.jsonc');
  const destination = join(dir, 'gateway.json');
  const raw = JSON.stringify({ mcpServers: {
    issues: { type: 'local', command: process.execPath, args: ['examples/demo-server.mjs', 'issues'], tools: ['list_issues'] },
    hidden: { command: '/not-installed-disabled-fixture', disabled: true },
    api: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${SETUP_TOKEN}' }, disabled: true },
  } });
  await writeFile(source, `// Existing settings\n${raw}`);
  const client = new Client({ name: 'setup-test', version: '1.0' });
  try {
    const preview = await cli(destination, 'setup', source, '--client', 'copilot', '--dry-run');
    assert.equal(preview.code, 0, preview.stderr);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
    const result = await cli(destination, 'setup', source, '--client', 'copilot', '--workspace', project);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(source, 'utf8'), `// Existing settings\n${raw}`);
    assert.doesNotMatch(result.stdout + result.stderr, /Bearer|SETUP_TOKEN/);
    const config = await loadConfig(destination);
    assert.equal(config.security?.allowCode, false);
    assert.equal(config.servers.hidden.disabled, true);
    assert.equal('cwd' in config.servers.issues && config.servers.issues.cwd, project);
    assert.deepEqual(config.servers.issues.allowedTools, ['list_issues']);
    assert.equal('headers' in config.servers.api && config.servers.api.headers?.Authorization, 'Bearer ${SETUP_TOKEN}');
    const generated = JSON.parse(result.stdout).mcpServers['local-mcp'];
    assert.ok(generated.args.every((arg: unknown) => typeof arg === 'string'));
    await client.connect(new StdioClientTransport({ command: generated.command, args: generated.args, cwd: dir, stderr: 'pipe' }));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['execute', 'search']);
    assert.equal(Object.hasOwn(tools.find(t => t.name === 'execute')!.inputSchema.properties ?? {}, 'code'), false);
    const response = await client.callTool({ name: 'execute', arguments: { call: { server: 'issues', tool: 'list_issues', args: { state: 'open' } } } });
    assert.notEqual(response.isError, true);
    assert.match(JSON.stringify(response), /issue-1/);
    assert.doesNotMatch(JSON.stringify(response), /issue-2/);
    const rerun = await cli(destination, 'setup', source, '--client', 'copilot', '--workspace', project);
    assert.equal(rerun.code, 0, rerun.stderr);
    if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('import failures are atomic, selective import is explicit, and existing policy is preserved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-import-atomic-'));
  const source = join(dir, 'client.json');
  const destination = join(dir, 'gateway.json');
  try {
    await saveConfig(destination, { version: 1, servers: { prior: { command: 'echo', allowedTools: [] } }, security: { allowCode: true }, limits: { maxTools: 99 } });
    const before = await readFile(destination, 'utf8');
    await writeFile(source, JSON.stringify({ mcpServers: { good: { command: 'echo' }, unsupported: { type: 'sse', url: 'https://example.test', headers: { secret: 'do-not-print-this' } } } }));
    let result = await cli(destination, 'import', source);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-this/);
    assert.equal(await readFile(destination, 'utf8'), before);
    result = await cli(destination, 'import', source, '--server', 'good');
    assert.equal(result.code, 0, result.stderr);
    const config = await loadConfig(destination);
    assert.deepEqual(config.servers.prior.allowedTools, []);
    assert.deepEqual(config.security, { allowCode: true });
    assert.deepEqual(config.limits, { maxTools: 99 });
    assert.equal(Object.hasOwn(config.servers, 'unsupported'), false);
    const after = await readFile(destination, 'utf8');
    await writeFile(source, JSON.stringify({ mcpServers: { good: { command: 'different' } } }));
    result = await cli(destination, 'import', source);
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(destination, 'utf8'), after);
    result = await cli(destination, 'setup', source, '--client', 'invalid');
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(destination, 'utf8'), after);
    result = await cli(source, 'import', source);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /different files/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OAuth disabled imports remain disabled at transport and explicit login boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-no-oauth-'));
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1/never-discover"' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const source = join(dir, 'opencode.json');
  const destination = join(dir, 'gateway.json');
  let upstreams: ReturnType<typeof createUpstreams> | undefined;
  try {
    await writeFile(source, JSON.stringify({ mcp: { api: { type: 'remote', url, oauth: false } } }));
    const result = await cli(destination, 'import', source);
    assert.equal(result.code, 0, result.stderr);
    const config = await loadConfig(destination);
    assert.equal('oauth' in config.servers.api && config.servers.api.oauth, false);
    upstreams = createUpstreams(config, destination);
    assert.deepEqual(await upstreams.listTools(), []);
    assert.ok(paths.length > 0);
    assert.ok(paths.every(path => path === '/mcp'));
    await assert.rejects(login('api', config.servers.api, destination), /OAuth is disabled/);
    await assert.rejects(stat(join(dir, '.local-mcp-auth')), { code: 'ENOENT' });
  } finally { await upstreams?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('doctor reports unavailable enabled servers with a failing exit status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-doctor-'));
  const destination = join(dir, 'gateway.json');
  try {
    await saveConfig(destination, { version: 1, servers: { missing: { command: '/not-installed-test-fixture' }, hidden: { command: '/not-installed-disabled', disabled: true } } });
    const result = await cli(destination, 'doctor');
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /missing\terror/);
    assert.match(result.stdout, /hidden\tdisabled/);
    assert.doesNotMatch(result.stdout + result.stderr, /not-installed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('imported environment references reach a real stdio process without appearing in setup output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-import-env-'));
  const source = join(dir, 'client.json');
  const destination = join(dir, 'gateway.json');
  const marker = join(dir, 'started');
  const serverCode = `
import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'started');
const server = new McpServer({name:'env-fixture',version:'1'});
server.registerTool('read_context',{inputSchema:{}},async()=>({content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),token:process.env.TOKEN})}]}));
await server.connect(new StdioServerTransport());
`;
  const client = new Client({ name: 'environment-setup-test', version: '1.0' });
  const value = 'fixture-private-token';
  try {
    await writeFile(join(dir, 'server.mjs'), serverCode);
    await writeFile(source, JSON.stringify({ mcp: { fixture: { type: 'local', command: [process.execPath, 'server.mjs'], environment: { TOKEN: '{env:SETUP_RUNTIME_TOKEN}' } } } }));
    let result = await cli(destination, 'setup', source, '--client', 'generic', '--workspace', dir, '--dry-run');
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    result = await cli(destination, 'setup', source, '--client', 'generic', '--workspace', dir);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /SETUP_RUNTIME_TOKEN|fixture-private-token/);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    const entry = JSON.parse(result.stdout).mcpServers['local-mcp'];
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: project, env: { SETUP_RUNTIME_TOKEN: value }, stderr: 'pipe' }));
    const response = await client.callTool({ name: 'execute', arguments: { call: { server: 'fixture', tool: 'read_context' } } });
    assert.notEqual(response.isError, true);
    const text = (response.content as Array<{text?:string}>).find(c => c.text)?.text ?? '';
    assert.deepEqual(JSON.parse(text), { cwd: dir, token: value });
    assert.equal(await readFile(marker, 'utf8'), 'started');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
