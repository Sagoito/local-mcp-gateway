import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startWebService } from '../src/web-service.js';

describe('web control service', () => {
  let dir: string;
  let service: Awaited<ReturnType<typeof startWebService>>;
  let admin: string;
  const cliPath = '/opt/local-mcp/dist/cli.js';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-mcp-web-'));
    service = await startWebService({
      configPath: join(dir, 'config.json'),
      port: 0,
      cliPath,
      assetsPath: join(process.cwd(), 'web'),
    });
    admin = new URL(service.dashboardUrl).hash.slice('#token='.length);
  });
  afterEach(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${service.origin}${path}`, init);
  const rawHostRequest = (path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const url = new URL(service.origin);
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path,
          headers: { Host: host },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('creates a default-deny config and a private independent MCP connection file', async () => {
    const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(config.security.allowCode, false);
    const connection = JSON.parse(
      await readFile(service.connectionFile, 'utf8'),
    );
    assert.equal(connection.version, 1);
    assert.equal(connection.url, `${service.origin}/mcp`);
    assert.match(connection.token, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32')
      assert.equal((await stat(service.connectionFile)).mode & 0o777, 0o600);
    const state = await request('/api/state', {
      headers: { Authorization: `Bearer ${admin}` },
    });
    assert.equal(state.status, 200);
    assert.equal(
      ((await state.json()) as { config: { security: { allowCode: boolean } } })
        .config.security.allowCode,
      false,
    );
    const connectionResponse = await request('/api/connection?client=generic', {
      headers: { Authorization: `Bearer ${admin}` },
    });
    const connectionData = (await connectionResponse.json()) as {
      entry: { mcpServers: Record<string, { args: string[] }> };
    };
    const entry = Object.values(connectionData.entry.mcpServers)[0]!;
    assert.deepEqual(entry.args.slice(1, 3), ['connect', '--connection-file']);
    assert.equal(
      JSON.stringify(connectionData).includes(connection.token),
      false,
    );
    assert.equal(JSON.stringify(connectionData).includes(admin), false);
  });

  it('rejects host and origin rebinding before authentication or parsing', async () => {
    assert.equal(await rawHostRequest('/api/state', 'localhost:43821'), 403);
    const origin = await request('/api/state', { headers: { Origin: 'null' } });
    assert.equal(origin.status, 403);
    const auth = await request('/api/servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    assert.equal(auth.status, 401);
  });

  it('bootstraps a same-origin HttpOnly session and requires the request marker', async () => {
    const bootstrap = await request('/api/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}` },
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const value = cookie.split(';', 1)[0]!;
    const denied = await request('/api/state', { headers: { Cookie: value } });
    assert.equal(denied.status, 401);
    const accepted = await request('/api/state', {
      headers: { Cookie: value, 'X-Weftly-Request': '1' },
    });
    assert.equal(accepted.status, 200);
  });

  it('enforces strict JSON and the one MiB request-body limit', async () => {
    const auth = { Authorization: `Bearer ${admin}` };
    const badType = await request('/api/refresh', {
      method: 'POST',
      headers: auth,
    });
    assert.equal(badType.status, 415);
    const huge = await request('/api/servers', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 'x',
        name: 'x',
        server: {},
        pad: 'x'.repeat(1024 * 1024),
      }),
    });
    assert.equal(huge.status, 413);
  });

  it('keeps the MCP endpoint on its independent bearer credential', async () => {
    const denied = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 401);
    const connection = JSON.parse(
      await readFile(service.connectionFile, 'utf8'),
    );
    const init = await request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    assert.equal(init.status, 200);
    const sessionId = init.headers.get('mcp-session-id')!;
    assert.ok(sessionId);
    const adminOnMcp = await request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${admin}`,
        'MCP-Session-Id': sessionId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    assert.equal(adminOnMcp.status, 401);
    const mcpOnAdmin = await request('/api/state', {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.equal(mcpOnAdmin.status, 401);
  });

  it('rejects invalid initialization without consuming slots and caps MCP sessions at 32', async () => {
    const { token } = JSON.parse(
      await readFile(service.connectionFile, 'utf8'),
    ) as { token: string };
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const bad = await request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'not-initialize',
        params: {},
      }),
    });
    assert.equal(bad.status, 400);
    const initialize = (id: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'slots', version: '1' },
        },
      });
    for (let id = 1; id <= 32; id++) {
      const response = await request('/mcp', {
        method: 'POST',
        headers,
        body: initialize(id),
      });
      assert.equal(response.status, 200, `session ${id} should initialize`);
    }
    const excess = await request('/mcp', {
      method: 'POST',
      headers,
      body: initialize(33),
    });
    assert.equal(excess.status, 503);
  });

  it('rejects malformed, linked, and non-private service connection files at startup', async () => {
    const configPath = join(dir, 'separate-config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        servers: {},
        inlineTools: [],
        security: { allowCode: false },
      }),
      { mode: 0o600 },
    );
    const file = `${configPath}.service.json`;
    const start = () =>
      startWebService({
        configPath,
        port: 0,
        cliPath,
        assetsPath: join(process.cwd(), 'web'),
      });

    await writeFile(file, '{broken', { mode: 0o600 });
    await assert.rejects(start());
    await rm(file);

    if (process.platform !== 'win32') {
      const target = join(dir, 'connection-target.json');
      await writeFile(
        target,
        JSON.stringify({
          version: 1,
          url: 'http://127.0.0.1:1/mcp',
          token: 'a'.repeat(43),
        }),
        { mode: 0o600 },
      );
      await symlink(target, file);
      await assert.rejects(start());
      await rm(file);

      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          url: 'http://127.0.0.1:1/mcp',
          token: 'a'.repeat(43),
        }),
        { mode: 0o644 },
      );
      await chmod(file, 0o644);
      await assert.rejects(start());
    }
  });
});
