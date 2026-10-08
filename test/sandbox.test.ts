import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCode } from "../src/sandbox.js";
import type { Upstreams } from "../src/types.js";

function mock(call: Upstreams["callTool"] = async (_server, tool, args) => ({ tool, args })): Upstreams {
  return { listTools: async () => [], callTool: call, close: async () => {} };
}

test("bridges calls and supports parallel MCP calls", async () => {
  const got: string[] = [];
  const upstreams = mock(async (_server, tool) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    got.push(tool);
    return { tool };
  });
  const out = await executeCode("const xs = await Promise.all([mcp.call('a','one'), mcp.call('a','two')]); return xs;", upstreams);
  assert.deepEqual(out, [{ tool: "one" }, { tool: "two" }]);
  assert.deepEqual(got.sort(), ["one", "two"]);
});

test("enforces timeout for loops and unresolved awaits", async () => {
  await assert.rejects(executeCode("while (true) {}", mock(), { timeoutMs: 100 }), /interrupt|timed out|timeout/i);
  await assert.rejects(executeCode("await new Promise(() => {}); return 1", mock(), { timeoutMs: 100 }), /timed out/i);
});

test("enforces RPC, result, and output limits", async () => {
  await assert.rejects(executeCode("await mcp.call('a','x'); await mcp.call('a','x');", mock(), { maxCalls: 1 }), /call limit/i);
  await assert.rejects(executeCode("return await mcp.call('a','x')", mock(async () => "x".repeat(100)), { maxOutputBytes: 20 }), /exceeds/i);
  await assert.rejects(executeCode("return 'x'.repeat(100)", mock(), { maxOutputBytes: 20 }), /exceeds/i);
});

test("cancels late upstream completion safely and permits filtering large intermediate results", async () => {
  const late = mock(async (_server, _tool, _args, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(signal?.aborted, true);
    return { done: true };
  });
  await assert.rejects(executeCode("await mcp.call('a','slow')", late, { timeoutMs: 50 }), /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 180));

  const large = mock(async () => ({ payload: "x".repeat(100_000), keep: 7 }));
  assert.equal(await executeCode("const value = await mcp.call('a','large'); return value.keep;", large, { maxOutputBytes: 10 }), 7);
});

test("isolates host globals, rejects non-JSON values, and bounds memory", async () => {
  const out = await executeCode("return [typeof process, typeof require, typeof fetch, typeof Deno]", mock());
  assert.deepEqual(out, ["undefined", "undefined", "undefined", "undefined"]);
  await assert.rejects(executeCode("return undefined", mock()), /serializable/i);
  await assert.rejects(executeCode("const x = []; for (;;) x.push('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');", mock(), { memoryBytes: 1024 * 1024 }), /memory|allocation|out of memory/i);
});

test("handles guest memory exhaustion while importing an upstream response", async () => {
  const large = mock(async () => ({ payload: 'x'.repeat(2_000_000) }));
  await assert.rejects(executeCode("return await mcp.call('a','large');", large,
    { memoryBytes: 1024 * 1024, timeoutMs: 1000 }), /memory|allocation|out of memory|InternalError/i);
  assert.equal(await executeCode('return 7;', mock()), 7, 'a failed sandbox does not break later executions');
});
