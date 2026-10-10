import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

test('direct benchmark daemon supports arbitrary stdio aliases and isolates runs', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'local-mcp-benchmark-'));
  const fixture = resolve('examples/demo-server.mjs');
  const daemon = spawn(process.execPath, [resolve('benchmark/daemon.mjs'), runsDir], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let daemonStderr = '';
  daemon.stderr.setEncoding('utf8').on('data', chunk => { daemonStderr += chunk; });
  const runA = `run-a-${Math.random().toString(36).slice(2, 9)}`;
  const runB = `run-b-${Math.random().toString(36).slice(2, 9)}`;
  const runC = `run-c-${Math.random().toString(36).slice(2, 9)}`;
  const runD = `run-d-${Math.random().toString(36).slice(2, 9)}`;
  const runE = `run-e-${Math.random().toString(36).slice(2, 9)}`;
  const largeFixture = resolve(`test/.benchmark-pager-${randomUUID()}.mjs`);
  const startsFile = join(runsDir, 'fixture-starts.txt');
  const writeConfig = async (runId: string, servers: Record<string, unknown>) => {
    const runDir = join(runsDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'config.json'), JSON.stringify({ mode: 'direct', gatewayConfig: { servers } }));
  };
  const bridge = async (runId: string, ...args: string[]) => {
    const { stdout } = await execFileAsync(process.execPath, [resolve('benchmark/bridge.mjs'), runsDir, runId, ...args], { timeout: 30_000, maxBuffer: 5_000_000 });
    return JSON.parse(stdout);
  };

  try {
    await writeFile(largeFixture, `
      import { appendFile } from 'node:fs/promises';
      import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
      import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
      import { z } from 'zod';
      await appendFile(process.argv[2], 'started\\n');
      const server = new McpServer({ name: 'benchmark-page-fixture', version: '1.0.0' });
      if (process.argv[3] === 'oversized') {
        server.registerTool('oversized_tool', { description: 'z'.repeat(13_000), inputSchema: { value: z.string() } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      } else {
        for (let i = 0; i < 24; i++) server.registerTool('bulk_tool_' + String(i).padStart(2, '0'), {
          description: 'Synthetic long tool description ' + i + ' ' + 'x'.repeat(700),
          inputSchema: { value: z.string().describe('Schema detail ' + 'y'.repeat(100)) },
        }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      }
      await server.connect(new StdioServerTransport());
    `);
    await writeConfig(runA, {
      alpha: { command: process.execPath, args: [fixture, 'issues'] },
      beta: { command: process.execPath, args: [fixture, 'builds'] },
      gamma: { command: process.execPath, args: [fixture, 'issues'] },
      delta: { command: process.execPath, args: [fixture, 'builds'] },
      epsilon: { command: process.execPath, args: [fixture, 'issues'] },
    });
    await writeConfig(runB, { zeta: { command: process.execPath, args: [fixture, 'builds'] } });
    await writeConfig(runC, {
      alpha: { command: process.execPath, args: [fixture, 'issues'] },
      zeta: { command: join(runsDir, 'missing-stdio-server') },
    });
    await writeConfig(runD, { bulk: { command: process.execPath, args: [largeFixture, startsFile] } });
    await writeConfig(runE, { bulk: { command: process.execPath, args: [largeFixture, startsFile, 'oversized'] } });

    await assert.rejects(bridge(runC, 'list'), /spawn|ENOENT|MCP connection/);
    await writeConfig(runC, { recovered: { command: process.execPath, args: [fixture, 'builds'] } });
    const recovered = await bridge(runC, 'list') as { tools: Array<{ name: string }> };
    assert.deepEqual(recovered.tools.map(tool => tool.name), ['recovered__get_build'], 'a failed partial startup does not poison a later retry');

    const completeCatalog = await bridge(runD, 'list') as { tools: unknown[] };
    const reconstructed: unknown[] = [];
    let pageCount = 0;
    for (let index = 0; ; index++) {
      const page = await bridge(runD, 'list', String(index)) as {
        tools: unknown[];
        catalogPage: { index: number; pages: number; totalTools: number; complete: boolean };
      };
      assert.ok(Buffer.byteLength(JSON.stringify({ tools: page.tools }), 'utf8') <= 12_000, 'each tool-list page stays within the UTF-8 byte budget');
      assert.deepEqual(page.catalogPage, { index, pages: page.catalogPage.pages, totalTools: 24, complete: true });
      assert.equal(page.catalogPage.pages, pageCount || page.catalogPage.pages);
      pageCount = page.catalogPage.pages;
      reconstructed.push(...page.tools);
      if (index + 1 === pageCount) break;
    }
    assert.ok(pageCount > 1, 'long tool descriptions require multiple pages');
    assert.equal(completeCatalog.tools.length, 24);
    assert.deepEqual(reconstructed, completeCatalog.tools, 'concatenated pages preserve every complete schema and tool entry');
    assert.equal((await readFile(startsFile, 'utf8')).trim().split('\n').length, 1, 'all pages reuse the same connected session and cached catalogue');
    await assert.rejects(bridge(runD, 'list', '999'), /out of range/);
    await assert.rejects(bridge(runD, 'list', '1.5'), /integer from 0 to 999/);
    await assert.rejects(bridge(runE, 'list', '0'), /exceeds the 12000-byte catalogue page limit/);
    const loggedPages = (await readFile(join(runsDir, runD, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(loggedPages.some((event: { op: string; page?: number }) => event.op === 'list' && event.page === 0));

    const firstList = await bridge(runA, 'list') as { tools: Array<{ name: string; description?: string; inputSchema: unknown }> };
    assert.deepEqual(firstList.tools.map(tool => tool.name), [
      'alpha__list_issues', 'beta__get_build', 'delta__get_build', 'epsilon__list_issues', 'gamma__list_issues',
    ]);
    assert.equal(firstList.tools.length, 5, 'all configured servers contribute their tool');
    assert.equal(typeof firstList.tools[0]?.inputSchema, 'object');
    assert.equal(typeof firstList.tools[0]?.description, 'string');

    const issueCall = await bridge(runA, 'call', 'gamma__list_issues', '{"state":"open"}') as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(issueCall.content[0]!.text), [{ id: 'issue-1', state: 'open', title: 'Improve example docs' }]);
    const buildCall = await bridge(runA, 'call', 'delta__get_build', '{"id":"build-17"}') as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(buildCall.content[0]!.text), [{ id: 'build-17', status: 'passed', durationSeconds: 42 }]);

    const secondList = await bridge(runB, 'list') as { tools: Array<{ name: string }> };
    assert.deepEqual(secondList.tools.map(tool => tool.name), ['zeta__get_build']);
    await bridge(runB, 'call', 'zeta__get_build', '{"id":"independent"}');
    await bridge(runA, 'finish', '{"ok":true}');
    assert.equal(JSON.parse(await readFile(join(runsDir, runA, 'answer.json'), 'utf8')).answer, '{"ok":true}');
    assert.equal((await bridge(runB, 'list') as { tools: unknown[] }).tools.length, 1, 'finishing one run leaves another live');
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise<void>(resolveExit => daemon.once('exit', () => resolveExit()));
      daemon.kill('SIGTERM');
      let timer: NodeJS.Timeout;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`daemon shutdown timed out: ${daemonStderr}`)), 10_000); })]);
      } finally { clearTimeout(timer!); }
    }
    await rm(largeFixture, { force: true });
    await rm(runsDir, { recursive: true, force: true });
  }
});
