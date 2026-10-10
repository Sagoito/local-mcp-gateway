import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveConfig } from '../src/config.js';
import { nativeName } from '../src/server.js';
import { startWebService } from '../src/web-service.js';

const sdk = (name: string) =>
  pathToFileURL(
    resolve('node_modules/@modelcontextprotocol/sdk/dist/esm', name),
  ).href;
const cliPath = resolve('dist/cli.js');

function text(result: unknown): string {
  if (
    !result ||
    typeof result !== 'object' ||
    !('content' in result) ||
    !Array.isArray(result.content)
  )
    return '';
  const item = result.content.find(
    (x) =>
      !!x &&
      typeof x === 'object' &&
      'type' in x &&
      x.type === 'text' &&
      'text' in x,
  );
  return item &&
    typeof item === 'object' &&
    'text' in item &&
    typeof item.text === 'string'
    ? item.text
    : '';
}

test('web service shares an upstream across HTTP and stdio bridge clients and revokes policy in existing sessions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-web-e2e-'));
  const clients: Client[] = [];
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const counterPath = join(dir, 'starts.txt');
  const fixturePath = join(dir, 'fixture.mjs');
  const fixture = `
import { appendFileSync } from 'node:fs';
import { Server } from ${JSON.stringify(sdk('server/index.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdk('types.js'))};
import { StdioServerTransport } from ${JSON.stringify(sdk('server/stdio.js'))};
appendFileSync(${JSON.stringify(counterPath)}, 'x');
const server = new Server({name:'loopback-fixture',version:'1'}, {capabilities:{tools:{}}});
const tools = [
 {name:'ping',description:'Return a fixture response',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}},
 {name:'big',description:'Return a large retained result',inputSchema:{type:'object',properties:{},additionalProperties:false}}
];
server.setRequestHandler(ListToolsRequestSchema, () => ({tools}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
 if(request.params.name==='ping') return {content:[{type:'text',text:'pong:'+request.params.arguments.value}]};
 if(request.params.name==='big') return {content:[{type:'text',text:JSON.stringify({rows:Array.from({length:450},(_,i)=>({id:i,padding:'z'.repeat(100)}))})}]};
 throw new Error('unknown tool');
});
await server.connect(new StdioServerTransport());
`;
  await writeFile(fixturePath, fixture);
  const configPath = join(dir, 'config.json');
  await saveConfig(configPath, {
    version: 1,
    servers: {
      fixture: {
        command: process.execPath,
        args: [fixturePath],
        allowedTools: ['ping', 'big'],
      },
    },
    inlineTools: [],
    nativeTools: [
      { server: 'fixture', tool: 'ping' },
      { server: 'fixture', tool: 'big' },
    ],
    security: { allowCode: true },
  });
  const service = await startWebService({
    configPath,
    port: 0,
    cliPath,
    assetsPath: resolve('web'),
  });
  t.after(async () => {
    await Promise.all(
      clients.map((client) => client.close().catch(() => undefined)),
    );
    await service.close();
  });
  const dashboardToken = new URL(service.dashboardUrl).hash.slice(
    '#token='.length,
  );
  const connection = JSON.parse(
    await readFile(service.connectionFile, 'utf8'),
  ) as { token: string };

  const httpClient = new Client({ name: 'web-http-test', version: '1' });
  clients.push(httpClient);
  await httpClient.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', service.origin), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const bridgeClient = new Client({ name: 'web-bridge-test', version: '1' });
  clients.push(bridgeClient);
  await bridgeClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'connect', '--connection-file', service.connectionFile],
      cwd: dirname(cliPath),
    }),
  );

  const httpTools = await httpClient.listTools();
  const bridgeTools = await bridgeClient.listTools();
  const pingName = nativeName('fixture', 'ping');
  const bigName = nativeName('fixture', 'big');
  assert.ok(httpTools.tools.some((tool) => tool.name === pingName));
  assert.ok(bridgeTools.tools.some((tool) => tool.name === pingName));
  assert.equal(
    JSON.parse(
      text(
        await httpClient.callTool({
          name: pingName,
          arguments: { value: 'http' },
        }),
      ),
    ),
    'pong:http',
  );
  assert.equal(
    JSON.parse(
      text(
        await bridgeClient.callTool({
          name: pingName,
          arguments: { value: 'stdio' },
        }),
      ),
    ),
    'pong:stdio',
  );
  assert.equal(
    (await readFile(counterPath, 'utf8')).length,
    1,
    'both clients should reuse the service upstream process',
  );

  const large = await httpClient.callTool({ name: bigName, arguments: {} });
  const payload = JSON.parse(text(large)) as {
    gatewayResult?: { id?: string };
  };
  assert.ok(
    payload.gatewayResult?.id,
    'large tool response should be retained in the originating MCP session',
  );
  const otherSession = await bridgeClient.callTool({
    name: 'execute',
    arguments: {
      result: { id: payload.gatewayResult.id, path: ['rows'], action: 'count' },
    },
  });
  assert.equal(
    otherSession.isError,
    true,
    'retained ids must not cross MCP session boundaries',
  );

  await saveConfig(configPath, {
    version: 1,
    servers: {
      fixture: {
        command: process.execPath,
        args: [fixturePath],
        allowedTools: ['ping', 'big'],
      },
    },
    inlineTools: [{ server: 'fixture', tool: 'big' }],
    nativeTools: [{ server: 'fixture', tool: 'ping' }],
    security: { allowCode: true },
  });
  const reselected = await httpClient.listTools();
  assert.ok(reselected.tools.some((tool) => tool.name === pingName));
  assert.equal(
    reselected.tools.some((tool) => tool.name === bigName),
    false,
  );
  assert.match(
    reselected.tools.find((tool) => tool.name === 'execute')?.description ?? '',
    /mcp\.call\("fixture","big"/,
    'an existing session must apply the new inline selector to its catalog',
  );

  const stateResponse = await fetch(`${service.origin}/api/state`, {
    headers: { Authorization: `Bearer ${dashboardToken}` },
  });
  const state = (await stateResponse.json()) as {
    revision: string;
    servers: Array<{
      name: string;
      transport: string;
      command?: string;
      args?: string[];
      allowedTools?: string[];
    }>;
  };
  const serverView = state.servers.find((server) => server.name === 'fixture')!;
  const update = await fetch(`${service.origin}/api/servers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${dashboardToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      revision: state.revision,
      name: 'fixture',
      server: {
        command: serverView.command,
        args: serverView.args,
        allowedTools: ['ping'],
      },
    }),
  });
  assert.equal(update.status, 200, await update.text());
  const afterRevocation = await httpClient.listTools();
  assert.equal(
    afterRevocation.tools.some((tool) => tool.name === bigName),
    false,
    'an established session must refresh its catalogue after allowlist revocation',
  );
  const denied = await httpClient.callTool({ name: bigName, arguments: {} });
  assert.equal(denied.isError, true);
});
