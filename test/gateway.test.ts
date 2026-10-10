import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { saveConfig } from '../src/config.js';
import { createGateway, searchCatalog } from '../src/server.js';
import type { GatewayConfig, ToolEntry, Upstreams } from '../src/types.js';

async function connected(gateway: ReturnType<typeof createGateway>) {
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), gateway.connect(serverTransport)]);
  return client;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find(item => item.type === 'text')?.text ?? '';
}

test('catalog discovery stays bounded and only expands the exact requested schema', async () => {
  const tools: ToolEntry[] = Array.from({ length: 1000 }, (_, i) => ({
    server: 'bulk', name: `tool_${i}`, description: `Synthetic fixture tool ${i}`,
    inputSchema: { type: 'object', properties: { [`arg_${i}`]: { type: 'string', description: 'large schema detail'.repeat(8) } } },
  }));
  const upstreams: Upstreams = { listTools: async () => tools, callTool: async () => ({}), close: async () => {} };
  const client = await connected(createGateway(upstreams));
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['execute', 'search']);
    const oneToolCatalog = await searchCatalogResponseFor([tools[0]!]);
    assert.equal(JSON.stringify(listed.tools), JSON.stringify(oneToolCatalog.tools));
    const compact = await client.callTool({ name: 'search', arguments: { query: 'tool_999', includeSchema: false } });
    const compactText = textOf(compact);
    assert.equal(compact.isError, undefined);
    assert.equal(compactText.includes('inputSchema'), false);
    const exact = await client.callTool({ name: 'search', arguments: { server: 'bulk', tool: 'tool_999', includeSchema: true } });
    const exactText = textOf(exact);
    assert.match(exactText, /arg_999/);
    assert.equal(exactText.includes('arg_998'), false);
    // Diagnostic reports actual fixture sizes, not token estimates.
    const directCatalogBytes = Buffer.byteLength(JSON.stringify(searchCatalog(tools, { limit: 8 })));
    console.log(`gateway catalog fixture: 1000 upstream tools; gateway list ${listed.tools.length} tools / ${Buffer.byteLength(JSON.stringify(listed.tools))} B (same list size with 1 upstream tool); direct 8-result catalog JSON ${directCatalogBytes} B; compact result ${Buffer.byteLength(compactText)} B; exact schema ${Buffer.byteLength(exactText)} B`);
  } finally { await client.close(); }
});

test('discovery defaults to three schemas and ranks capability terms above server aliases', async () => {
  const tools: ToolEntry[] = [
    { server: 'issues-api', name: 'list_open_issues', description: 'Find active issues', inputSchema: { type: 'object', properties: {} } },
    { server: 'issues-api', name: 'search_issue_history', description: 'Search historical issue records', inputSchema: { type: 'object', properties: { phrase: { type: 'string' } } } },
    { server: 'issues-api', name: 'search_issues_legacy', description: 'Deprecated issue search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { server: 'builds', name: 'get_build', description: 'Retrieve build status', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  ];
  const ranked = searchCatalog(tools, { query: 'issues-api search' });
  const rankedNames = (ranked.results as Array<{ name: string }>).map(item => item.name);
  assert.deepEqual(rankedNames, ['search_issue_history', 'search_issues_legacy']);

  const client = await connected(createGateway({ listTools: async () => tools, callTool: async () => ({}), close: async () => {} }));
  try {
    const defaults = await client.callTool({ name: 'search', arguments: {} });
    const result = JSON.parse(textOf(defaults));
    assert.equal(result.results.length, 3);
    assert.ok(result.results.every((item: ToolEntry) => item.inputSchema));
    const compact = await client.callTool({ name: 'search', arguments: { includeSchema: false, limit: 1 } });
    const compactResult = JSON.parse(textOf(compact));
    assert.equal(compactResult.results.length, 1);
    assert.equal('inputSchema' in compactResult.results[0], false);
  } finally { await client.close(); }
});

async function searchCatalogResponseFor(catalog: ToolEntry[]) {
  const client = await connected(createGateway({ listTools: async () => catalog, callTool: async () => ({}), close: async () => {} }));
  try { return await client.listTools(); } finally { await client.close(); }
}

test('execute composes calls, filters raw MCP content, and exposes failures as tool errors', async () => {
  const upstreams: Upstreams = {
    listTools: async () => [], close: async () => {},
    callTool: async (server, tool) => {
      if (tool === 'broken') throw new Error('synthetic upstream failure');
      if (tool === 'large') return { content: [{ type: 'text', text: JSON.stringify({ rows: Array.from({ length: 1000 }, (_, id) => ({ id, label: `record-${id}`, noise: 'x'.repeat(100) })) }) }] };
      return { content: [{ type: 'text', text: JSON.stringify([{ server, id: 7, private: 'discard me' }]) }] };
    },
  };
  const client = await connected(createGateway(upstreams));
  try {
    const composed = await client.callTool({ name: 'execute', arguments: { code: `const [a,b] = await Promise.all([mcp.call('alpha','items'), mcp.call('beta','items')]); return [a,b].flatMap(r => JSON.parse(r.content[0].text)).map(({server,id}) => ({server,id}));` } });
    assert.equal(composed.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(composed)), [{ server: 'alpha', id: 7 }, { server: 'beta', id: 7 }]);
    const filtered = await client.callTool({ name: 'execute', arguments: { code: `const raw=await mcp.call('alpha','large'); const source=raw.content[0].text; const rows=JSON.parse(source).rows; return {sourceBytes:source.length,count:rows.length,lastId:rows[rows.length-1].id};` } });
    assert.equal(filtered.isError, undefined);
    const filteredValue = JSON.parse(textOf(filtered));
    assert.ok(filteredValue.sourceBytes > 32_768, 'intermediate MCP result exceeds final output budget');
    assert.deepEqual({ count: filteredValue.count, lastId: filteredValue.lastId }, { count: 1000, lastId: 999 });
    assert.ok(Buffer.byteLength(textOf(filtered)) < 100, 'only the small filtered result reaches the caller');
    const failed = await client.callTool({ name: 'execute', arguments: { code: `return await mcp.call('alpha','broken')` } });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /synthetic upstream failure/);
  } finally { await client.close(); }
});

test('stdio gateway searches, returns exact schema, executes across aliases, and hot reload removes a server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-integration-'));
  const configPath = join(dir, 'config.json');
  const fixture = resolve('examples/demo-server.mjs');
  const config: GatewayConfig = { version: 1, servers: {
    issues: { command: process.execPath, args: [fixture, 'issues'] },
    builds: { command: process.execPath, args: [fixture, 'builds'] },
  } };
  await saveConfig(configPath, config);
  const gatewayClient = new Client({ name: 'stdio-integration-test', version: '1.0.0' });
  const gatewayTransport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', '--config', configPath, 'serve'], cwd: process.cwd(), stderr: 'pipe' });
  try {
    await gatewayClient.connect(gatewayTransport);
    const search = await gatewayClient.callTool({ name: 'search', arguments: { query: 'issues' } });
    assert.match(textOf(search), /list_issues/);
    const schema = await gatewayClient.callTool({ name: 'search', arguments: { server: 'issues', tool: 'list_issues', includeSchema: true } });
    assert.match(textOf(schema), /state/);
    const result = await gatewayClient.callTool({ name: 'execute', arguments: { code: `const [issues,build] = await Promise.all([mcp.call('issues','list_issues',{state:'open'}),mcp.call('builds','get_build',{id:'build-17'})]); const rows=JSON.parse(issues.content[0].text); const b=JSON.parse(build.content[0].text); return {open:rows.filter(x=>x.state==='open').map(x=>x.id), build:b[0].status};` } });
    assert.deepEqual(JSON.parse(textOf(result)), { open: ['issue-1'], build: 'passed' });
    config.servers = { builds: config.servers.builds! };
    await saveConfig(configPath, config);
    const unavailable = await gatewayClient.callTool({ name: 'execute', arguments: { code: `return await mcp.call('issues','list_issues',{})` } });
    assert.equal(unavailable.isError, true);
    assert.match(textOf(unavailable), /issues/);
    await gatewayClient.close();
  } finally {
    await gatewayTransport.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
