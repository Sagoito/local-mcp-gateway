#!/usr/bin/env node
// Tiny deterministic MCP fixture for the README and stdio integration test.
// It writes protocol traffic only to stdout; diagnostics belong on stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const kind = process.argv[2];
const server = new McpServer({
  name: `local-mcp-demo-${kind}`,
  version: '1.0.0',
});
if (kind === 'issues') {
  server.registerTool(
    'list_issues',
    {
      description: 'List demonstration issues, optionally filtered by state.',
      inputSchema: { state: z.enum(['open', 'closed']).optional() },
    },
    async ({ state }) => {
      const rows = [
        { id: 'issue-1', state: 'open', title: 'Improve example docs' },
        { id: 'issue-2', state: 'closed', title: 'Fix fixture typo' },
      ].filter((issue) => !state || issue.state === state);
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    },
  );
} else if (kind === 'builds') {
  server.registerTool(
    'get_build',
    {
      description: 'Get a deterministic demonstration build by identifier.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify([{ id, status: 'passed', durationSeconds: 42 }]),
        },
      ],
    }),
  );
} else {
  process.stderr.write('usage: demo-server.mjs issues|builds\n');
  process.exitCode = 2;
}
if (kind === 'issues' || kind === 'builds')
  await server.connect(new StdioServerTransport());
