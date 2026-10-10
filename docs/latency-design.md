# Latency design: remove discovery turns when the catalogue is small

Research reviewed 2026-10-08/09. Sources are primary vendor documentation; measurements below belong to this project, not the vendors.

## Findings

Cloudflare documents two distinct Code Mode patterns: inline generated type declarations for a manageable MCP tool set, and search/execute for a large API. Its inline pattern lets one outer call compose several upstream operations. Therefore forcing progressive discovery for our 23-tool benchmark imposed a round trip the model did not need.

Sources: [Code Mode MCP patterns](https://developers.cloudflare.com/agents/model-context-protocol/codemode/) and [single-tool guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/).

Anthropic explicitly notes that tool search adds latency and recommends keeping 3–5 frequently used tools non-deferred. Programmatic composition saves model round trips when intermediate work can be expressed in code. This supports a hybrid design, not a claim that search-first is always faster.

Sources: [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) and [Tool search documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).

## Implementation

Still two public tools: search and execute. At startup the gateway obtains upstream schemas and renders deterministic compact argument signatures into execute's description. If the entire catalogue fits within 4,096 UTF-8 bytes and 64 tools, it is included. Otherwise no partial, arbitrary catalogue is included and normal search remains available. The actual two-MCP catalogue is about 2.4 KB; rich descriptions and full schemas stay out of the initial prompt. Signature hints explicitly omit full validation constraints. Unsupported schema forms degrade to unknown; full schemas remain available through search.

Rendering bounds depth, property counts, enum/union counts, identifiers and per-tool node visits. Names/keys are escaped. Ordering is deterministic. Config replacement refreshes the description when the next request reloads upstreams. Clients receive the SDK's list-changed notification, but clients that ignore updates may retain old hints; calls still use current upstream configuration. In-place upstream schema changes without config replacement are not pushed into inline hints automatically; restart or use search for the current schema.

The gateway reuses upstream connections and the WASM module while creating an isolated runtime for each execution. Parallel calls inside one script use Promise.all. No extra LLM, embeddings server, remote router or task-specific tool definitions are introduced.

## Tradeoffs

The initial prompt grows by a bounded amount to remove an inference round trip. Tool discovery connection cost moves into startup, and unavailable upstreams can delay startup under existing connection timeouts. Large catalogues still use search and do not receive the same latency benefit. An optional explicit `inlineTools` selection keeps up to five user-selected signatures ready across a larger setup, within the same byte budget. An empty selection disables inline hints. This affects discovery hints only, not authorization. Automatic per-task selection would require client/harness integration or another inference/retrieval stage; it is not implemented here.

This is an architectural latency improvement, not a security upgrade. Inline signatures do not grant new permissions, validate arguments, or replace upstream authorization. Generated code still reaches all configured tools. Host-enforced allowlists and approvals remain necessary before unrestricted sensitive use. Vendor documentation also distinguishes code isolation from authorization.

## Evaluation

Six unchanged synthetic tasks × two repetitions × three conditions = 36 fresh gpt-6-luna agents, medium reasoning, up to four concurrent workers. Rotate condition order. Compare the new gateway against a frozen compiled snapshot of commit 6f09ea5 (previous gateway) and direct MCPs in the same session. No completed failures are retried. Use the same generic bridge, MCP versions, prompts, fixture contents and 12-call cap.

The mailbox daemon now atomically claims request files to prevent duplicate execution/logging. All three arms use that same corrected harness. Record cold list setup separately but include it in total elapsed time, so preloading is not hidden. The compiled gateway used by agents is frozen during runs. Optional working-set configuration was added afterward in source and verified separately; the agent benchmark measures automatic small-catalogue mode, not the selected-working-set mode. Actual model billing/hidden reasoning and native client deferred-tool behavior remain unavailable. Full logged payload can exceed model-visible output due to host truncation; it must not be called actual context usage. Two repetitions per task support a pilot comparison, not statistical proof or production latency guarantees.

## Follow-up: structured single-call execution

The 36-run inline catalogue pilot reduced the median versus the contemporaneous old gateway by 23.7%, but still incurred code-generation errors. A subsequent 12-run gateway-only pass tests an additive structured call option on execute: `{call:{server,tool,args}}`. It uses the same host upstream adapter and bounded results but never evaluates JavaScript. Code remains optional for filtering/composition. This pass is exploratory: controls were run immediately earlier, not interleaved again. Its results must be distinguished from the 36-run comparison. No code was changed during either measured compiled run set.

## Follow-up: bounded native working set and retained results

The structured-call traces show that Luna still attempts discovered names as outer tools, then retries. Oversized reads also error before the model learns the data shape, causing repeated upstream reads and failed array assumptions. Tool-RPC time accounts for tens of milliseconds while these model/bridge turns take seconds. This makes removing turns more valuable than optimizing the transport further in this workload.

An optional `nativeTools` set now exposes up to five common tools directly, sharing an 8 KiB full-definition budget. The SDK's public low-level Server API preserves complete upstream JSON schemas and annotations; upstream servers validate arguments. Ordinary names match the direct benchmark's server__tool aliases. The remaining tools use search/execute. Automatic inline signatures are suppressed for this profile to avoid duplicating the catalogue. This explicitly trades a small bounded initial context for direct call latency; it does not preserve a strict two-tool interface in native mode.

Native and structured calls retain oversized raw responses in a bounded in-memory result store and return a handle plus a generic shape summary. `mcp.result(id)` retrieves the snapshot inside the existing isolated QuickJS runtime. The agent can filter it without fetching upstream again. The cache has eight entries, 8 MiB total capacity, five-minute TTL and clears on config replacement/disconnect; it does not establish new permissions or evaluate upstream text.

The prespecified 24-run plan is in [NATIVE_PLAN.md](../benchmark/NATIVE_PLAN.md). The same curated five-tool set applies to every question. This tests a configured common-tool profile, not automatic selection across arbitrary workloads.

## Structured retained JSON queries and language choice

The native-v5 pilot reached an aggregate median of 7.50 s versus 8.30 s direct (means 9.77 s versus 9.71 s), but retained a 28.25 s join outlier with four quoting-related JavaScript errors. The query follow-up adds `execute.result`, a structured operation on retained JSON, for array paths, scalar comparisons, field selection and all/first/count. It has fixed work and output bounds, uses own JSON properties, evaluates no generated code, and invokes no upstream operation. Optional QuickJS code remains for custom processing. See [QUERY_PLAN.md](../benchmark/QUERY_PLAN.md).

For this gateway, TypeScript/Node is a reasonable host choice: existing traces place tool-call RPC totals in milliseconds and extra agent turns in seconds. A host-language rewrite cannot remove those inference/retry turns. MCP maintains an [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) with client/server transports and OAuth helpers, which this project uses. Node deployment has a runtime/dependency footprint; a later native packaging effort could address installation needs, but no Go/Rust comparison is measured here. Host implementation language and permitting model-generated code are separate decisions. The measured architecture removes generated code from common operations instead of requiring a different host language.
