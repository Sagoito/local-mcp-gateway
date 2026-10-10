#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const [runsArg, runId, op, ...rest] = process.argv.slice(2);
const runsDir = path.resolve(runsArg ?? '');
const safeId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
if (!runsArg || !safeId(runId) || !['list', 'call', 'finish'].includes(op)) {
  console.error(
    "Usage: node benchmark/bridge.mjs RUNS_DIR RUN_ID list [PAGE_INDEX] | call TOOL '<JSON args>' | finish '<JSON answer>'",
  );
  process.exit(2);
}
let name, args, answer, page;
try {
  if (op === 'list') {
    if (rest.length > 1) throw new Error('list accepts at most one page index');
    if (rest.length === 1) {
      if (!/^\d+$/.test(rest[0]))
        throw new Error('list page index must be an integer from 0 to 999');
      page = Number(rest[0]);
      if (!Number.isInteger(page) || page > 999)
        throw new Error('list page index must be an integer from 0 to 999');
    }
  } else if (op === 'call') {
    name = rest[0];
    args = JSON.parse(rest[1] ?? '{}');
    if (
      typeof name !== 'string' ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args)
    )
      throw new Error('call requires TOOL and a JSON object');
  } else if (op === 'finish') {
    if (!rest.length) throw new Error('finish requires a final answer string');
    answer = rest.join(' ');
  }
} catch (error) {
  console.error(`bridge: ${error.message}`);
  process.exit(2);
}
const inbox = path.join(runsDir, 'inbox');
const outbox = path.join(runsDir, 'outbox');
await mkdir(inbox, { recursive: true });
await mkdir(outbox, { recursive: true });
const id = randomUUID();
const requestPath = path.join(inbox, `${id}.json`);
const responsePath = path.join(outbox, `${id}.json`);
await writeFile(
  `${requestPath}.tmp`,
  JSON.stringify({
    id,
    runId,
    op,
    ...(name ? { name } : {}),
    ...(args ? { args } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(page !== undefined ? { page } : {}),
  }),
  { mode: 0o600 },
);
await rename(`${requestPath}.tmp`, requestPath);
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    const response = JSON.parse(await readFile(responsePath, 'utf8'));
    if (response.id !== id) throw new Error('Mismatched daemon response');
    if (Object.hasOwn(response, 'error')) {
      console.error(`bridge: ${response.error}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(response.result));
    process.exit(0);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`bridge: ${error.message}`);
      process.exit(1);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
console.error('bridge: timed out waiting for daemon response');
process.exit(1);
