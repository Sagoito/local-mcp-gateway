import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCode } from "../src/sandbox.js";
import type { Upstreams } from "../src/types.js";

function mock(call: Upstreams["callTool"] = async (_server, tool, args) => ({ tool, args }), getResult?: Upstreams["getResult"]): Upstreams {
  return { listTools: async () => [], callTool: call, ...(getResult ? { getResult } : {}), close: async () => {} };
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

test("keeps mcp.call raw and adds text and JSON result helpers", async () => {
  const response = {
    content: [
      { type: "image", data: "ignored" },
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
    structuredContent: { source: "structured" },
  };
  const upstreams = mock(async () => response);
  const out = await executeCode(`
    const raw = await mcp.call('a', 'x');
    return { raw, text: mcp.text(raw) };
  `, upstreams);
  assert.deepEqual(out, { raw: response, text: "first\nsecond" });

  const parsed = await executeCode("return mcp.json(await mcp.call('a','x'));", mock(async () => ({
    content: [{ type: "text", text: '{"answer":42}' }],
    structuredContent: { answer: 0 },
  })));
  assert.deepEqual(parsed, { answer: 42 });

  const structured = await executeCode("return mcp.json(await mcp.call('a','x'));", mock(async () => ({
    content: [{ type: "image", data: "ignored" }],
    structuredContent: { answer: 42 },
  })));
  assert.deepEqual(structured, { answer: 42 });
});

test("retrieves retained raw results through mcp.result", async () => {
  const retained = {
    content: [{ type: "text", text: '{"answer":42}' }],
    structuredContent: { answer: 42 },
  };
  const ids: string[] = [];
  const upstreams = mock(undefined, async (id) => {
    ids.push(id);
    return retained;
  });
  const out = await executeCode("return mcp.json(await mcp.result('result-17'));", upstreams);
  assert.deepEqual(out, { answer: 42 });
  assert.deepEqual(ids, ["result-17"]);

  await assert.rejects(executeCode("return await mcp.result('missing');", mock(undefined, async () => undefined)), /Unknown MCP result handle/i);
  await assert.rejects(executeCode("return await mcp.result('result-17');", mock()), /retained results are unavailable/i);
});

test("mcp.call and mcp.result share the sandbox call budget", async () => {
  const upstreams = mock(async () => ({ ok: true }), async () => ({ ok: true }));
  await assert.rejects(executeCode(`
    await mcp.call('a', 'x');
    return await mcp.result('result-17');
  `, upstreams, { maxCalls: 1 }), /call limit \(1\) exceeded/i);
});

test("result helpers report tool errors, missing text, and malformed JSON clearly", async () => {
  const errored = mock(async () => ({ isError: true, content: [{ type: "text", text: "failed" }] }));
  await assert.rejects(executeCode("return mcp.text(await mcp.call('a','x'));", errored), /MCP tool returned an error result/i);
  await assert.rejects(executeCode("return mcp.json(await mcp.call('a','x'));", errored), /MCP tool returned an error result/i);

  const structuredOnly = mock(async () => ({ structuredContent: { ok: true } }));
  await assert.rejects(executeCode("return mcp.text(await mcp.call('a','x'));", structuredOnly), /no text content/i);
  await assert.rejects(executeCode("return mcp.json(await mcp.call('a','x'));", mock(async () => ({ content: [] }))), /neither text content nor structuredContent/i);

  const malformed = mock(async () => ({
    content: [{ type: "text", text: "{broken" }],
    structuredContent: { fallback: true },
  }));
  await assert.rejects(executeCode("return mcp.json(await mcp.call('a','x'));", malformed), /MCP text content is not valid JSON:.*expecting property name/i);
});

test("mcp.rows accepts arrays and unambiguous array properties, and diagnoses ambiguous shapes", async () => {
  const out = await executeCode(`
    return [mcp.rows([1, 2]), mcp.rows({ records: [3] })];
  `, mock());
  assert.deepEqual(out, [[1, 2], [3]]);

  await assert.rejects(executeCode("return mcp.rows({ left: [1], right: [2] });", mock()),
    /multiple array-valued properties.*left, right.*Object keys: \[left, right\].*Select an explicit array property/i);
  await assert.rejects(executeCode("return mcp.rows({ count: 2, label: 'x' });", mock()),
    /no array-valued property.*Object keys: \[count, label\].*Select an explicit array property/i);
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
