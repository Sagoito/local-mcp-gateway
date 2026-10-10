# Measured context scaling with many MCP servers

The gateway's initial advertised definition payload stayed constant while the complete direct catalogue grew. With 32 actual MCP server processes and 368 upstream tools, direct definitions measured **44,959 token proxies**, versus **1,647** with five native tools plus search/execute: **96.3% smaller**. The default two-tool gateway measured **754**: **98.3% smaller**.

These are complete serialized `tools/list` payloads tokenized with `o200k_base`, not provider-reported context, usage or billed costs.

## Results

| Configured servers | Upstream tools | Direct tokens | Gateway: five native tools + search/execute | Reduction | Gateway: default search/execute |
|---:|---:|---:|---:|---:|---:|
| 2 | 23 | 2,749 | 1,647 | 40.1% | 1,408 |
| 8 | 92 | 11,191 | 1,647 | 85.3% | 754 |
| 16 | 184 | 22,447 | 1,647 | 92.7% | 754 |
| 32 | 368 | 44,959 | 1,647 | 96.3% | 754 |

Default mode includes bounded inline signatures when the full catalogue fits its 4 KiB/64-tool limits. Those signatures fit at two servers and automatically drop out at the larger sizes. The native profile selects the same five primary tools at every scale; it does not select tools separately for each question. Its complete definition payload has the same SHA-256 at all four scales.

| Configured servers | Direct UTF-8 bytes | Native-profile bytes | Default-profile bytes |
|---:|---:|---:|---:|
| 2 | 13,179 | 7,390 | 5,752 |
| 8 | 52,956 | 7,390 | 3,140 |
| 16 | 105,992 | 7,390 | 3,140 |
| 32 | 212,064 | 7,390 | 3,140 |

## What was measured

Installed official filesystem and memory MCP servers, both version 2026.8.31, were started through the real MCP SDK stdio transport. Their 14 and 9 tools respectively were replicated as isolated, separately named endpoints. All four scales started real processes; the larger numbers are not extrapolations or invented schemas. Auxiliary data roots and memory files are isolated from the primary benchmark data. This is **two server implementations replicated across 32 endpoints**, not 32 distinct vendors or authenticated integrations.

For each scale, the harness connected to every upstream, collected all paginated SDK tool lists, and measured direct, default-gateway and native-gateway definitions. Gateway discovery was checked against the actual full upstream tool count with no unavailable servers. Direct comparable definitions retain name, description and inputSchema, as in previous agent pilots; complete original upstream SDK tool objects, including additional metadata, are also retained in [catalogs.json.gz](catalogs.json.gz).

The gateway build is unchanged from query-v6. The new work is measurement and benchmark instrumentation. [catalog-summary.json](catalog-summary.json) and [catalog.csv](catalog.csv) include exact bytes, token proxies, hashes and diagnostic setup timings.

## Startup and latency limits

Reducing advertised definitions does not reduce the number of upstream connections in the current eager-discovery implementation. Single observed connection/list times at 32 servers were 1,942 ms direct, 2,041 ms default gateway and 2,151 ms native gateway. These are diagnostic observations, not repeated latency measurements or a speed claim. The gateway still starts every configured stdio process.

The planned large-catalogue agent validation could not provide a fair answer-latency comparison through this host's output path. Direct workers saw truncation markers when the complete 32-server list was printed, despite requested output budgets of 70,000. A fresh 16-server layout was also clipped. Six completed 32-server outcomes and four completed 16-server outcomes are retained; the remaining planned runs were never started. None of those layouts is presented as a fair full-catalogue performance comparison. Wrong completed answers were not replaced with successes.

A separate Luna delivery audit confirmed that splitting the 32-server list into 19 complete-schema pages still clips when all pages are emitted in one invocation. Seven invocations, each emitting at most three pages, delivered all 368 tools without visible clipping, including the primary filesystem/memory schemas. However, those extra model turns would add orchestration time and context replay to the direct arm. We therefore did not run another task pilot with that delivery path or use it to claim a gateway latency advantage. A native client that injects the complete tool registry is needed for that comparison.

The aborted layouts' [32-server analysis](aborted-32/README.md), [16-server analysis](aborted-16/README.md), manifests, outcomes and raw responses remain reviewable. The payload metrics in their generated analyses describe full daemon responses; they do not establish what a worker actually received. [audit.json.gz](audit.json.gz) preserves all trial configs, prompts, events, answers and delivery observations.

## Interpretation

This establishes a large reduction in **initial advertised tool-definition payload against an eager all-tools baseline**. It does not measure the benefit against a client that already defers MCP schemas, such as a tool-search implementation. It does not establish actual billed savings, model-specific token counts, total conversation savings, end-to-end speed at 32 servers or vendor OAuth compatibility. Later search results, tool responses, generated requests and model reasoning also consume context.

## Reproduce

Requires Node.js 22+, the pinned dependencies and enough resources for 32 local processes:

```sh
npm ci
npm run build
node benchmark/measure-scale.mjs /tmp/local-mcp-scale benchmark/results/scale-v7 dist/cli.js
```

The measurement writes complete archives and overwrites the catalogue result files. See [SCALE_PLAN.md](../../SCALE_PLAN.md) for the original plan and documented delivery adaptations. `prepare-paged.mjs` and the optional bridge page argument support future delivery diagnostics; they are not changes to the gateway's public MCP interface.

All 59 tests pass, including real stdio multi-alias routing, session isolation, complete-schema page reconstruction, invalid page handling and oversized-schema rejection.
