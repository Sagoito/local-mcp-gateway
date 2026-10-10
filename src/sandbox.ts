import { newQuickJSWASMModule } from "quickjs-emscripten";
import type { Upstreams, SandboxOptions } from "./types.js";

const DEFAULT_TIMEOUT = 15_000;
const MAX_TIMEOUT = 60_000;
const DEFAULT_MEMORY = 32 * 1024 * 1024;
const DEFAULT_CALLS = 32;
const DEFAULT_OUTPUT = 32 * 1024;
const MAX_CODE = 64 * 1024;
const MAX_RPC_RESULT = 8 * 1024 * 1024;
// Reuse the expensive WASM module initialization while creating a new runtime and
// context for every execution below. QuickJS state therefore remains isolated.
const wasmModule = newQuickJSWASMModule();

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return Math.floor(value);
}

function jsonBytes(value: unknown, limit: number, label: string): string {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new TypeError(`${label} is not JSON serializable`); }
  if (json === undefined) throw new TypeError(`${label} is not JSON serializable`);
  if (Buffer.byteLength(json, "utf8") > limit) throw new RangeError(`${label} exceeds ${limit} bytes`);
  return json;
}

/** Runs a JavaScript function body in a fresh QuickJS WASM runtime. */
export async function executeCode(code: string, upstreams: Upstreams, options: SandboxOptions = {}): Promise<unknown> {
  if (typeof code !== "string" || Buffer.byteLength(code, "utf8") > MAX_CODE) throw new RangeError(`Code exceeds ${MAX_CODE} bytes`);
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT, 1, MAX_TIMEOUT, "timeoutMs");
  const memoryBytes = bounded(options.memoryBytes, DEFAULT_MEMORY, 1024 * 1024, 256 * 1024 * 1024, "memoryBytes");
  const maxCalls = bounded(options.maxCalls, DEFAULT_CALLS, 1, 10_000, "maxCalls");
  const maxOutputBytes = bounded(options.maxOutputBytes, DEFAULT_OUTPUT, 1, 16 * 1024 * 1024, "maxOutputBytes");
  const deadline = Date.now() + timeoutMs;
  const wasm = await wasmModule;
  const runtime = wasm.newRuntime({ memoryLimitBytes: memoryBytes });
  const context = runtime.newContext();
  const abort = new AbortController();
  let calls = 0;
  let disposed = false;
  let callbackFailure: Error | undefined;
  const deferreds = new Set<ReturnType<typeof context.newPromise>>();
  const jsonObject = context.getProp(context.global, "JSON");
  const jsonParse = context.getProp(jsonObject, "parse");
  runtime.setInterruptHandler(() => Date.now() >= deadline);

  const pump = () => {
    if (disposed) return;
    const result = runtime.executePendingJobs();
    if (result.error) {
      const message = String(context.dump(result.error));
      result.error.dispose();
      throw new Error(message);
    }
  };
  const errorMessage = (handle: ReturnType<typeof context.newError>) => {
    const message = context.getProp(handle, "message");
    try {
      const text = context.getString(message);
      return text || String(context.dump(handle));
    } catch { return String(context.dump(handle)); }
    finally { message.dispose(); }
  };
  const parse = (json: string) => {
    if (disposed) throw new Error("Sandbox has been disposed");
    const arg = context.newString(json);
    try {
      const result = context.callFunction(jsonParse, jsonObject, arg);
      if (result.error) {
        const message = errorMessage(result.error);
        result.error.dispose();
        throw new TypeError(message);
      }
      return result.value;
    }
    finally { arg.dispose(); }
  };
  const hostPromise = (promise: Promise<unknown>) => {
    const deferred = context.newPromise();
    deferreds.add(deferred);
    void promise.then((value) => {
      if (disposed) return;
      const handle = parse(String(value));
      deferred.resolve(handle);
      handle.dispose();
    }, (reason: unknown) => {
      if (disposed) return;
      const error = context.newError(reason instanceof Error ? reason.message : String(reason));
      deferred.reject(error);
      error.dispose();
    }).catch((error: unknown) => {
      // Parsing may fail when a large intermediate result exhausts the guest heap.
      // Surface it to the main loop rather than leaving a pending promise until timeout.
      if (!disposed) callbackFailure = error instanceof Error ? error : new Error('Unable to import MCP result');
    });
    return deferred.handle;
  };
  const reject = (message: string) => hostPromise(Promise.reject(new Error(message)));
  const callBridge = context.newFunction("call", (serverH, toolH, argsH) => {
    if (++calls > maxCalls) return reject(`MCP call limit (${maxCalls}) exceeded`);
    const server = context.getString(serverH);
    const tool = context.getString(toolH);
    let args: unknown;
    try { args = JSON.parse(context.getString(argsH)); }
    catch { return reject("Invalid MCP arguments"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) return reject("MCP arguments must be an object");
    const rpc = Promise.resolve().then(() => upstreams.callTool(server, tool, args as Record<string, unknown>, abort.signal))
      .then((value) => jsonBytes(value, MAX_RPC_RESULT, "MCP result"));
    return hostPromise(rpc);
  });
  const resultBridge = context.newFunction("result", (idH) => {
    if (++calls > maxCalls) return reject(`MCP call limit (${maxCalls}) exceeded`);
    const id = context.getString(idH);
    if (!id) return reject("MCP result handle must be a non-empty string");
    if (!upstreams.getResult) return reject("MCP retained results are unavailable");
    const result = Promise.resolve().then(() => upstreams.getResult!(id)).then((value) => {
      if (value === undefined) throw new Error(`Unknown MCP result handle "${id}"`);
      return jsonBytes(value, MAX_RPC_RESULT, "MCP result");
    });
    return hostPromise(result);
  });
  context.setProp(context.global, "__hostCall", callBridge);
  context.setProp(context.global, "__hostResult", resultBridge);
  callBridge.dispose();
  resultBridge.dispose();

  const prelude = `
    delete globalThis.process; delete globalThis.require; delete globalThis.fetch;
    delete globalThis.XMLHttpRequest; delete globalThis.WebSocket; delete globalThis.console;
    const __safeStringify = JSON.stringify.bind(JSON);
    const __safeCall = globalThis.__hostCall;
    const __safeResult = globalThis.__hostResult;
    const text = result => {
      if (result && result.isError === true) throw new Error('MCP tool returned an error result');
      const blocks = result && Array.isArray(result.content) ? result.content : [];
      const texts = blocks.filter(block => block && block.type === 'text' && typeof block.text === 'string');
      if (texts.length === 0) throw new TypeError('MCP result contains no text content');
      return texts.map(block => block.text).join('\\n');
    };
    const json = result => {
      if (result && result.isError === true) throw new Error('MCP tool returned an error result');
      const blocks = result && Array.isArray(result.content) ? result.content : [];
      const texts = blocks.filter(block => block && block.type === 'text' && typeof block.text === 'string');
      if (texts.length > 0) {
        const source = texts.map(block => block.text).join('\\n');
        try { return JSON.parse(source); }
        catch (error) {
          const detail = error && typeof error.message === 'string' ? error.message : String(error);
          throw new TypeError('MCP text content is not valid JSON: ' + detail);
        }
      }
      if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')) return result.structuredContent;
      throw new TypeError('MCP result has neither text content nor structuredContent');
    };
    const rows = value => {
      if (Array.isArray(value)) return value;
      const keys = value !== null && typeof value === 'object' ? Object.getOwnPropertyNames(value) : [];
      const arrayKeys = keys.filter(key => Array.isArray(value[key]));
      if (arrayKeys.length === 1) return value[arrayKeys[0]];
      const reason = arrayKeys.length === 0
        ? 'no array-valued property was found'
        : 'multiple array-valued properties were found: ' + arrayKeys.join(', ');
      throw new TypeError('mcp.rows expects an array or an object with exactly one array-valued property; ' + reason + '. Object keys: [' + keys.join(', ') + ']. Select an explicit array property.');
    };
    const mcp = Object.freeze({call: (server, tool, args = {}) => {
      if (typeof server !== 'string' || typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args))
        return Promise.reject(new TypeError('mcp.call expects server, tool, and object arguments'));
      return __safeCall(server, tool, __safeStringify(args));
    }, result: id => {
      if (typeof id !== 'string' || id.length === 0)
        return Promise.reject(new TypeError('mcp.result expects a non-empty result handle string'));
      return __safeResult(id);
    }, text, json, rows});
  `;
  try {
    const init = context.evalCode(prelude);
    if (init.error) {
      const message = String(context.dump(init.error));
      init.error.dispose();
      throw new Error(message);
    }
    init.value.dispose();
    const result = context.evalCode(`(async () => { const value = await (async () => {\n${code}\n})(); return __safeStringify(value); })()`);
    if (result.error) {
      const message = String(context.dump(result.error));
      result.error.dispose();
      throw new Error(message);
    }
    const promise = result.value;
    try {
      while (true) {
        if (callbackFailure) throw callbackFailure;
        if (Date.now() >= deadline) throw new Error(`Sandbox timed out after ${timeoutMs}ms`);
        pump();
        const state = context.getPromiseState(promise);
        if (state.type === "fulfilled") {
          try {
            const output = context.getString(state.value);
            if (Buffer.byteLength(output, "utf8") > maxOutputBytes) throw new RangeError(`Output exceeds ${maxOutputBytes} bytes`);
            try { return JSON.parse(output); }
            catch { throw new TypeError("Sandbox result is not JSON serializable"); }
          } finally { state.value.dispose(); }
        }
        if (state.type === "rejected") {
          try { throw new Error(errorMessage(state.error)); }
          finally { state.error.dispose(); }
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } finally { promise.dispose(); }
  } finally {
    abort.abort();
    disposed = true;
    for (const deferred of deferreds) deferred.dispose();
    deferreds.clear();
    jsonParse.dispose();
    jsonObject.dispose();
    context.dispose();
    runtime.dispose();
  }
}
