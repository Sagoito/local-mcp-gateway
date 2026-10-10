#!/usr/bin/env node
// Deterministic stdio MCP fixture for upstream discovery and policy tests.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const [countText = '2', mode = 'normal', marker = ''] = process.argv.slice(2);
const count = Number(countText);
const tools = Array.from({ length: count }, (_, i) => ({
  name: `tool${i + 1}`,
  description: 'x'.repeat(
    mode === 'oversized' ? 2048 : mode === 'medium' ? 700 : 8,
  ),
  inputSchema: { type: 'object', properties: {} },
}));
if (mode === 'duplicate') tools[1] = { ...tools[0] };
if (mode === 'invalid-name') tools[0].name = 'bad\nname';
const server = new Server(
  { name: 'discovery-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
let listCalls = 0;
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  listCalls++;
  if (marker) appendFileSync(marker, 'LIST\n');
  if (mode === 'fail-first' && listCalls === 1)
    throw new Error('fixture transient failure');
  const cursor = request.params?.cursor;
  if (mode === 'repeat-cursor')
    return cursor === 'again'
      ? { tools: tools.slice(1), nextCursor: 'again' }
      : { tools: tools.slice(0, 1), nextCursor: 'again' };
  if (count > 1 && cursor !== 'page2')
    return { tools: tools.slice(0, 1), nextCursor: 'page2' };
  return { tools: cursor === 'page2' ? tools.slice(1) : tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (marker) appendFileSync(marker, `CALL:${request.params.name}\n`);
  return { content: [{ type: 'text', text: request.params.name }] };
});
await server.connect(new StdioServerTransport());
