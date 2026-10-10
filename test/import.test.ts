import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importClientConfig } from '../src/import.js';

const run = (text: string, options: Record<string,unknown> = {}) => importClientConfig(text, { workspaceDir: '/work/project', ...options } as never);

test('imports JSONC stdio settings and safely translates variables', () => {
  const r = run(`{// comments and string delimiters
    "mcpServers": {"demo": {"command":"node", "args":["server.js", "//literal", "comma,}"], "env":{"TOKEN":"\${env:API_TOKEN}","DIR":"\${workspaceFolder}"},},},
  }`);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.servers.demo, { command: 'node', args: ['server.js', '//literal', 'comma,}'], env: { TOKEN: '${API_TOKEN}', DIR: '/work/project' }, cwd: '/work/project' });
});

test('imports VS Code server maps, filters, disabled state and cwd', () => {
  const r = run(JSON.stringify({ servers: { local: { type: 'stdio', command: 'python', args: ['${workspaceFolder}/s.py'], cwd: 'sub', tools: ['read'], enabled: false }, web: { type: 'http', url: 'https://example.test/mcp', tools: [] } } }));
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.servers.local, { command: 'python', args: ['/work/project/s.py'], cwd: '/work/project/sub', disabled: true, allowedTools: ['read'] });
  assert.deepEqual(r.servers.web, { url: 'https://example.test/mcp', allowedTools: [] });
});

test('imports OpenCode local and remote entries with OAuth references', () => {
  const r = run(JSON.stringify({ mcp: { local: { type: 'local', command: ['node', 'srv.js'], enabled: false, tools: ['*'] }, remote: { type: 'remote', url: 'https://example.test/mcp', oauthClientId: 'client', oauth: { clientSecret: '${env:OAUTH_SECRET}' } } } }));
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.servers.local, { command: 'node', args: ['srv.js'], cwd: '/work/project', disabled: true });
  assert.deepEqual(r.servers.remote, { url: 'https://example.test/mcp', oauth: { clientId: 'client', clientSecretEnv: 'OAUTH_SECRET' } });
});

test('selection excludes unsupported unselected entries', () => {
  const r = run(JSON.stringify({ mcpServers: { good: { command: 'node' }, bad: { type: 'sse', url: 'https://example.test' } } }), { names: ['good'] });
  assert.deepEqual(r.issues, []);
  assert.deepEqual(Object.keys(r.servers), ['good']);
});

test('reports malformed input without leaking source values', () => {
  const secret = 'super-secret-value';
  const r = run(`{"mcpServers":{"a":{"command":"${secret}",`);
  assert.equal(r.issues[0].message, 'Malformed JSONC input');
  assert.equal(JSON.stringify(r.issues).includes(secret), false);
});

test('rejects ambiguous roots, SSE, OAuth scope, literal secrets and unsupported policy', () => {
  assert.match(run('{"servers":{},"mcpServers":{}}').issues[0].message, /Ambiguous/);
  const r = run(JSON.stringify({ mcpServers: {
    sse: { type: 'sse', url: 'https://example.test' },
    scope: { type: 'http', url: 'https://example.test', oauth: { scopes: ['a'] } },
    secret: { type: 'http', url: 'https://example.test', oauth: { clientSecret: 'secret-value' } },
    timeout: { command: 'run', timeout: 5 }
  } }));
  assert.equal(r.issues.length, 4);
  assert.equal(JSON.stringify(r.issues).includes('secret-value'), false);
});

test('rejects unsafe names and unsupported variables', () => {
  const parsed = JSON.parse('{"mcpServers":{"__proto__":{"command":"bad"},"bad":{"command":"${input:thing}"}}}');
  const r = run(JSON.stringify(parsed));
  assert.equal(r.issues.length, 2);
  assert.equal(r.issues.some(x => x.server === '__proto__'), false);
});

test('rejects duplicate JSONC keys including escaped-equivalent keys', () => {
  const cases = [
    '{"mcpServers":{},"mcpServers":{}}',
    '{"mcpServers":{"x":{"command":"a","tools":[],"tools":["read"]}}}',
    '{"mcpServers":{},"mcp\\u0053ervers":{}}'
  ];
  for (const source of cases) {
    const r = run(source);
    assert.equal(r.issues[0].message, 'Malformed JSONC input');
    assert.equal(JSON.stringify(r.issues).includes(source), false);
  }
});

test('validates format-specific fields, transport combinations, OAuth and placeholders', () => {
  const r = run(JSON.stringify({ mcpServers: {
    wrongType: { type: 'remote', url: 'https://example.test' },
    both: { command: 'run', url: 'https://example.test' },
    wrongField: { type: 'http', url: 'https://example.test', cwd: '.' },
    badOauth: { type: 'http', url: 'https://example.test', oauth: { mysterious: true } },
    fallback: { command: 'run', env: { VALUE: '${VALUE:-fallback}' } },
    configRef: { command: 'run', env: { VALUE: '${config:workspaceFolder}' } },
    oidc: { type: 'http', url: 'https://example.test', oauth: { clientSecret: '${GITHUB_COPILOT_OIDC_MCP_TOKEN_MY_SVC}' } },
    ok: { type: 'http', url: 'https://example.test', oauth: false }
  } }));
  assert.equal(r.issues.length, 7);
  assert.deepEqual(r.servers.ok, { url: 'https://example.test', oauth: false });
  const unknownFormat = run('{"mcp":{}}', { format: 'invalid' });
  assert.equal(unknownFormat.issues[0].message, 'Unsupported import format');
});

test('translates OpenCode environment and OAuth compatibility fields safely', () => {
  const r = run(JSON.stringify({ mcp: {
    local: { type: 'local', command: ['node', 'server.js'], environment: { TOKEN: '${env:API_TOKEN}' }, cwd: '${workspaceFolder}/child' },
    remote: { type: 'remote', url: 'https://example.test', oauthClientId: 'direct', oauth: { clientId: 'nested' } }
  } }));
  assert.equal(r.issues.length, 1);
  assert.deepEqual(r.servers.local, { command: 'node', args: ['server.js'], env: { TOKEN: '${API_TOKEN}' }, cwd: '/work/project/child' });
});

test('rejects unterminated JSONC block comments', () => {
  const r = run('{"mcpServers":{} /* never closed');
  assert.equal(r.issues[0].message, 'Malformed JSONC input');
});

test('preserves Copilot local entries, client IDs, empty filters and disabled OAuth without widening access', () => {
  const r = run(JSON.stringify({ mcpServers: {
    local: { type: 'local', command: 'node', args: ['literal$NAME'], env: { TOKEN: '$TOKEN' }, enabled: false, tools: [] },
    remote: { type: 'http', url: 'https://example.test', oauthClientId: '${CLIENT_ID}' },
    noOAuth: { type: 'http', url: 'https://example.test', oauth: false, tools: [] }
  } }));
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.servers.local, { command: 'node', args: ['literal$NAME'], env: { TOKEN: '${TOKEN}' }, cwd: '/work/project', disabled: true, allowedTools: [] });
  assert.deepEqual(r.servers.remote, { url: 'https://example.test', oauth: { clientId: '${CLIENT_ID}' } });
  assert.deepEqual(r.servers.noOAuth, { url: 'https://example.test', oauth: false, allowedTools: [] });
});

test('rejects conflicting disabled OAuth, scopes, grants, client sandbox and enterprise rules', () => {
  for (const extra of [
    { oauth: false, oauthClientId: 'id' }, { oauthScopes: ['read'] },
    { oauthGrantType: 'client_credentials' }, { oauthPublicClient: false },
  ]) {
    const r = run(JSON.stringify({ mcpServers: { x: { type: 'http', url: 'https://example.test', ...extra } } }));
    assert.equal(r.issues.length, 1);
    assert.equal(Object.keys(r.servers).length, 0);
  }
  for (const key of ['sandbox', 'permission', 'permissions', 'enterprise']) {
    const r = run(JSON.stringify({ servers: { x: { command: 'node' } }, [key]: {} }));
    assert.equal(r.issues.length, 1);
  }
  const invalid = run(JSON.stringify({ servers: { x: { command: 'node', sandboxEnabled: true } } }));
  assert.equal(invalid.issues.length, 1);
});

test('JSONC preserves escaped strings and rejects leading commas and escaped-equivalent duplicate keys', () => {
  for (const text of ['{"mcpServers":{,}}', '{"mcpServers":{"x":{"command":"node","args":[,]}}}', String.raw`{"mcpServers":{},"mcp\u0053ervers":{}}`]) {
    assert.equal(run(text).issues[0]?.message, 'Malformed JSONC input');
  }
  const value = 'quotes" slash\\ comma,} // /*';
  const r = run(JSON.stringify({ mcpServers: { x: { command: 'node', args: [value] } } }));
  assert.deepEqual(r.issues, []);
  assert.equal('args' in r.servers.x && r.servers.x.args?.[0], value);
});

test('accepts UTF-8 BOM and refuses working-directory references that could change path meaning', () => {
  assert.deepEqual(run('\uFEFF{"servers":{"x":{"command":"node"}}}').issues, []);
  const r = run(JSON.stringify({ mcpServers: { x: { command: 'node', cwd: '${PROJECT_DIR}' } } }));
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0].message, /absolute working directory/);
});
