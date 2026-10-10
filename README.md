# Local MCP Gateway

Local MCP Gateway runs locally and keeps the advertised MCP tool set bounded. It exposes `search` and `execute` by default, with an optional set of up to five directly callable upstream tools for lower latency. Single operations use structured calls; optional JavaScript combines or filters results before returning them.

## Install and start

Requires Node.js 22 or newer.

```sh
git clone https://github.com/Sagoito/local-mcp-gateway.git
cd local-mcp-gateway
npm ci
npm run build
```

The CLI takes an optional config path before or after the command. If omitted, it uses `$LOCAL_MCP_CONFIG` or `~/.config/local-mcp/config.json`.

```sh
node dist/cli.js --config ./config.json init
node dist/cli.js --config ./config.json list
node dist/cli.js --config ./config.json doctor
```

To use `local-mcp` instead of `node dist/cli.js`, you may run `npm link` from this directory. This makes the command available on your machine; the project does not install or publish it globally for you.

## Connect upstream servers

Add a Streamable HTTP server with `--url`, or a stdio server with `-- COMMAND [ARGS...]`:

```sh
node dist/cli.js --config ./config.json add issues --url https://mcp.example.test/mcp
node dist/cli.js --config ./config.json add local-tools --env API_TOKEN='${TOKEN}' -- node /absolute/path/to/server.mjs --mode stdio
node dist/cli.js --config ./config.json list
node dist/cli.js --config ./config.json remove local-tools
```

For stdio servers, repeat `--env KEY=VALUE` to pass environment variables to the child process. Adding a name that already exists fails; remove it first, then add the replacement.

For HTTP headers, repeat `--header` as needed. Values may contain `${ENV_NAME}` references, expanded from the environment of the gateway process:

```sh
node dist/cli.js --config ./config.json add issues --url https://mcp.example.test/mcp \
  --header 'Authorization=Bearer ${TOKEN}'
```

Set `TOKEN` in the environment of the MCP client process that launches the gateway. Desktop clients do not necessarily inherit variables from an interactive shell. Keep secrets out of checked-in config files.

OAuth login is an explicit command for an HTTP upstream. The gateway discovers whether the upstream requires OAuth during login, then opens a browser for authorization code with PKCE. `--oauth-client-id` can provide a pre-registered client ID when needed:

```sh
node dist/cli.js --config ./config.json login issues
```

For example, add a preregistered upstream with `node dist/cli.js --config ./config.json add issues --url https://mcp.example.test/mcp --oauth-client-id 'your-registered-client-id'`. The current callback is `http://127.0.0.1:43127/callback` on a fixed loopback port. OAuth state and tokens are stored as plaintext JSON files. On POSIX systems their permissions are restricted to the current user (`0600`; containing directory `0700`); on Windows, use a user-private configuration directory and appropriate filesystem permissions. They are not encrypted, and the gateway does not use an OS keychain or credential vault. An upstream must accept this callback and support the implemented OAuth flow; compatibility with any particular vendor is not guaranteed.

## Run through an MCP client

Configure your MCP client to launch the gateway over stdio. Use an absolute path to `dist/cli.js`; include environment variables here if the upstream config references them:

```json
{
  "mcpServers": {
    "local-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/local-mcp/dist/cli.js", "--config", "/absolute/path/to/config.json", "serve"],
      "env": {
        "TOKEN": "replace-with-your-token"
      }
    }
  }
}
```

The gateway checks the config again before each request and applies changes on the next tool call. Restarting the client is usually unnecessary after adding or removing an upstream.

## Discover and execute tools

At startup the gateway includes compact argument signatures in `execute` when the complete catalogue fits within 4 KiB and 64 tools. Use those signatures immediately; no discovery call is needed. Larger catalogues retain search-based discovery. This adds a bounded amount of initial context and moves upstream discovery into startup.

`search` returns up to three matching tools with argument schemas by default, so discovery and schema lookup can share one round trip. Use `includeSchema:false` for compact summaries, or request an exact server/tool:

```json
{"query":"issues","includeSchema":false}
```

```json
{"server":"issues","tool":"list_issues","includeSchema":true}
```

For a single upstream operation, `execute` accepts a structured call without generated code:

```json
{"call":{"server":"issues","tool":"list_issues","args":{"state":"open"}}}
```

Text results are parsed as JSON when possible, otherwise returned as text. Non-text content remains a raw MCP result. Results over 32 KiB return a retained-result handle and bounded shape summary; the raw-result limit is 8 MiB. Use `mcp.result(id)` inside code to filter the retained result without fetching it again. This route still permits side effects allowed by upstream credentials; it is not a read-only mode.

For composition/filtering, `execute` accepts a JavaScript async function body in `code`. Supply exactly one of `call`, `result` or `code`. `mcp.call(server, tool, args)` returns the raw upstream MCP `CallToolResult`, including its `content` array and any `structuredContent`. For example, if a tool returns both fields:

```js
const result = await mcp.call("issues", "list_issues", { state: "open" });
return {
  structured: result.structuredContent,
  content: result.content
};
```

The returned `content` might look like `[{"type":"text","text":"..."}]`; `structuredContent` is included when the upstream provides it. Return only the fields the caller needs. Multiple upstream calls can be combined in one execution:

```js
const [issues, build] = await Promise.all([
  mcp.call("issues", "list_issues", { state: "open" }),
  mcp.call("build", "get_build", { id: "latest" })
]);
return {
  issues: issues.structuredContent ?? issues.content,
  build: build.structuredContent ?? build.content
};
```

### Try the local demo

The demo MCP server in `examples/demo-server.mjs` provides `list_issues` and `get_build`. Configure aliases to its `issues` and `builds` modes, then use them in `search` and `execute`:

```sh
node dist/cli.js --config ./demo-config.json add issues -- node "$PWD/examples/demo-server.mjs" issues
node dist/cli.js --config ./demo-config.json add build -- node "$PWD/examples/demo-server.mjs" builds
node dist/cli.js --config ./demo-config.json doctor
```

Point your MCP client configuration at `demo-config.json` as shown above (using an absolute path), then search for `list issues` and execute:

```js
const [issues, build] = await Promise.all([
  mcp.call("issues", "list_issues", {}),
  mcp.call("build", "get_build", { id: "demo-1" })
]);
return {
  issues: issues.structuredContent ?? issues.content,
  build: build.structuredContent ?? build.content
};
```

The demo server is a fixture, not a real issue tracker or build service.

### Result helpers

`mcp.call` still returns the raw MCP result. Inside `execute`, `mcp.text(result)` joins text blocks, while `mcp.json(result)` parses text as JSON (or uses structuredContent when there is no text). Both reject upstream error results. `mcp.rows(value)` accepts an array, or extracts the only array-valued property of an object; ambiguous objects require an explicit property.

```js
const raw = await mcp.call("issues", "list_issues", { state: "open" });
return mcp.rows(mcp.json(raw)).map(issue => ({ id: issue.id }));
```

These helpers do not execute text from upstream results. Use `Promise.all` for independent calls. Tool names returned by search are invoked inside `execute`. Configured native tools are also available directly under the names advertised by the client.

## Limits and security notes

**This prototype is not an authorization boundary.** Generated code cannot directly access host filesystem or network APIs, but `mcp.call` can invoke any configured upstream tool, including destructive operations. The gateway does not enforce tool allowlists, argument policies, or per-operation approvals. Client approval of the outer `execute` call must not be mistaken for inspection/approval of every nested action. Prompt injection in upstream descriptions/results remains a risk, and read tools can still expose sensitive data. A compromised upstream stdio process also runs outside QuickJS with the gateway user's OS permissions.

Before sensitive deployments, enforce permissions at each upstream, use narrowly scoped credentials, and add host-side tool/argument policies and trusted approval handling. QuickJS resource bounds reduce exposure but are not a claim of OS-level isolation or a security audit.

- The gateway process runs locally, but configured upstream services and the model/client may be remote. No telemetry is sent by this project itself.
- `execute` runs JavaScript in a QuickJS sandbox with no filesystem, network, imports, or console access. Defaults are 32 upstream calls, 32 MiB of JavaScript heap, a 15-second execution timeout (maximum 60 seconds), and 32 KiB of returned JSON. Each individual MCP response is limited to 8 MiB before the final result is assembled; the 32 KiB final output limit still applies. Individual upstream calls have a 30-second timeout. Cancellation on timeout is best effort and does not roll back side effects already performed upstream.
- Discovery is lexical matching over tool names and descriptions. It is not semantic search. Search responses are limited to 24 KiB; narrow by server/tool when needed.
- The gateway's `execute` tool can invoke upstream tools that make changes or other side effects. It does not ask for approval before each upstream call. Only execute actions authorized by the user.
- The gateway proxies tools only. It does not proxy upstream resources, prompts, sampling, or elicitation. Upstream connections support stdio and MCP Streamable HTTP. Legacy SSE transport is not supported. The CLI and sandbox are JavaScript/TypeScript based.

## Development

```sh
npm test
npm run build
```

`npm test` runs the TypeScript build first, then the test suite.

## Verification

Validated with Node.js 24 on Linux. The automated suite covers CLI configuration and secret-reference preservation, real stdio MCP composition and config reload, sandbox time/memory/output limits and cleanup, and mocked SDK OAuth discovery, dynamic registration, PKCE code exchange and token refresh.

In a synthetic catalog test, the two advertised gateway tool definitions remain small without inline signatures; the optional inline catalogue adds at most 4,096 UTF-8 bytes before JSON escaping. Another test filters over 100 KB of intermediate data to less than 100 bytes of final JSON. These are byte measurements, not model token counts or measured cost/latency savings.

Browser callback handling and real vendor OAuth interoperability have not been exercised end to end. Test your first authenticated upstream before relying on this prototype. No service credentials are included. Retained results live only in gateway-process memory: eight entries, 8 MiB total, five-minute TTL, LRU capacity eviction. Config replacement and disconnect clear them. Handles are opaque references within the same client session, not separate authorization grants.

## License

[MIT](LICENSE). Copyright (c) 2026 Sagoito. Dependencies retain their respective licenses.

## Discovery architecture

See the [research and design notes](docs/latency-design.md) for the inline-catalogue fast path, large-catalogue fallback, startup tradeoffs and benchmark method. Compact signatures are hints; upstream validation and authorization still apply.

### Keep common tools ready in larger setups

Set optional `inlineTools` in your gateway config to select up to five existing upstream tools for inline argument hints. Omit it for the automatic small-catalogue mode, or set `[]` to disable inline hints. The same 4 KiB budget applies; if selected signatures exceed it, discovery is used instead. Restart the MCP client after editing for immediate visibility, or let the next gateway request trigger config reload.

```json
{
  "version": 1,
  "servers": {
    "files": { "command": "node", "args": ["/absolute/path/to/filesystem-server.js", "/allowed/path"] }
  },
  "inlineTools": [
    { "server": "files", "tool": "read_text_file" },
    { "server": "files", "tool": "search_files" }
  ]
}
```

This controls context hints, **not access permissions**. Other tools remain discoverable and callable. Removing a server also removes its inline selections. Signatures for missing tools are omitted; use search or doctor to check what the upstream actually exposes.

### Expose common tools directly for lower latency

Set `nativeTools` to advertise up to five upstream tools with their complete argument schemas. The names are normally `server__tool`; long or unusual names use a stable shortened hash suffix. Call the exact advertised name with ordinary arguments. The gateway forwards arguments to the upstream, which validates them, and returns parsed text/JSON. A native single call does not execute JavaScript.

```json
{
  "version": 1,
  "servers": {
    "files": { "command": "node", "args": ["/absolute/path/to/filesystem-server.js", "/allowed/path"] }
  },
  "nativeTools": [
    { "server": "files", "tool": "read_text_file" },
    { "server": "files", "tool": "search_files" }
  ]
}
```

The native definitions share an 8 KiB JSON budget; schemas are never partially truncated. Definitions exceeding the budget or count remain available through discovery/execute. Native descriptions are clipped to 600 characters; search returns more information. Missing tools are omitted. Selection follows config order. This provides at most seven public tools, independent of how many upstream tools are configured. When nonempty `nativeTools` is configured, automatic inline signatures are disabled; an explicit `inlineTools` list can enable a separate bounded set of hints. Removing a server prunes both selections. Config replacement refreshes the definitions on the next tool call and sends a list-changed notification; restart clients that ignore notifications. In-place upstream schema changes require a restart for refreshed native definitions.

A response too large for the 32 KiB output budget returns `{gatewayResult:{id,bytes,shape},hint}`. The shape includes bounded object keys and array lengths/item keys, not complete data. For a JSON result with a `records` array:

```js
const raw = await mcp.result("the-handle-returned-by-your-call");
const data = mcp.json(raw);
return { count: data.records.length };
```

Use `mcp.text(raw)` for ordinary text. Follow the returned shape rather than assuming an array. Handles expire or are evicted when limits are reached; repeat the upstream operation only if a handle is no longer available. Cache reads count toward the sandbox's 32-call budget. Native selections and retained-result handles do not restrict other upstream tool permissions.


### Filter retained JSON without JavaScript

For ordinary filtering prefer `execute` with `result`. It operates on a previously returned handle, and supports an array path, AND scalar comparisons, field selection, and `all`, `first` or `count` actions. For example, when the returned shape shows a `records` array with a `status` field:

```json
{
  "result": {
    "id": "the-returned-handle",
    "path": ["records"],
    "where": [{"field": ["status"], "op": "eq", "value": "open"}],
    "action": "count"
  }
}
```

Use `action:"first"` to return a matching record or null, or `action:"all"` for the matching array. Optional `fields:["id","status"]` projects top-level keys. Comparisons support `eq`, `ne`, `lt`, `lte`, `gt` and `gte`; ordering compares strings lexically or numbers numerically, without coercion. Missing fields never match, including `ne`. Field/path traversal reads only own JSON properties. The selected array may contain at most 100,000 records, and evaluation permits at most 1,000,000 visits; exceeding either fails rather than returning an incomplete answer. Output remains capped at 32 KiB. This route neither evaluates generated code nor invokes an upstream operation.


## Evaluation and comparison limits

Stage 1 adds a cached local BM25 index. The full ToolRet development fixture contains 44,453 tools and 7,961 queries.

| Retrieval condition | nDCG@10 / errors, full suite | Full-suite warm SDK p50 / p95 | Paired-sample SDK p50 / p95 |
|---|---:|---:|---:|
| Indexed product search | 0.295644 / 0 | 2.44 / 6.70 ms | 2.59 / 4.92 ms |
| Frozen BM25 reference | 0.296189 / 0 | — | — |
| Historical v9 gateway | 0.063799 / 360 | — | 417.88 / 834.70 ms |

The full-suite run took 916 ms for its first cold search; its warm latency covers all 7,961 queries after ten fixed warmup calls. The paired sample uses 90 category-stratified queries and two balanced repetitions; it was not source-stratified. The historical row’s latency comes from that sample, while retrieval scores cover the full suite. A separate index-only diagnostic measured a 116.5 ms build for 5,000 tools; this is not a 5,000-tool SDK latency result. Production discovery remains capped at 5,000 tools. Full-suite peak RSS was 631 MiB, including the index, SDK, and benchmark data. Initial MCP definitions remain two tools and measured 3,131 JSON bytes (753 o200k token proxy); the proxy is not provider usage or billed cost. Cold search was slower than v9 (883.6 vs 693.5 ms). The new 8,192-character limit accepted the 360 queries the old v9 interface rejected.

ToolRet measures retrieval behavior, not answer quality, competitor parity, provider usage, or cost. Server aliases remain searchable for users who query connector names; the benchmark is a measurement, not a ranking target. See the [public-v10 report](benchmark/results/public-v10/README.md) and [comparison protocol](benchmark/COMPARABILITY_PLAN.md) for full results, scope, and reproduction instructions. Historical task and context pilots remain limited local studies: [initial task pilot](benchmark/results/local-luna/README.md), [latency follow-up](benchmark/results/latency-v2/README.md), [structured-call latency](benchmark/results/typed-v4/README.md), [final latency pilot](benchmark/results/query-v6/README.md), [many-server context](benchmark/results/scale-v7/README.md), and [quality pilot](benchmark/results/quality-v8/README.md). Their results do not establish general answer quality or billed savings.
