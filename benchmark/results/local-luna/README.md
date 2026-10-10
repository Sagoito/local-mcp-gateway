# Local Luna pilot: less MCP payload, slower answers

Executed 24 completed fresh-agent runs (6 questions × 2 conditions × 2 repetitions) using gpt-6-luna, medium reasoning, and the official filesystem and memory MCP servers, both version 2026.8.31. The gateway core was unchanged. All 22 project tests passed after installing dependencies.

| Measurement | Direct eager schemas | Gateway |
|---|---:|---:|
| Initial list payload | 13,179 bytes | 1,528 bytes |
| Initial list o200k token proxy | 2,749 | 358 |
| Correct final answers | 10/12 | 12/12 |
| Median elapsed to answer | 7.85 s | 19.83 s |
| Agent tool calls (total) | 23 | 68 |
| Tool errors recovered or returned (total) | 0 | 11 |
| Median accumulated payload token proxy | 4,286.5 | 3,590 |
| Large-filter question payload proxy (median) | 127,218 | 3,151 |

The initial tool-list payload shrank by 88.4% in bytes / 87.0% in token proxy. Gateway elapsed time was about 2.5× higher overall. It was slower for every question's two-run median. Discovery and code generation added agent turns; broad searches sometimes expanded many schemas, and Luna sometimes tried calling discovered tools directly or assumed the wrong result shape before recovering. Two small file reads are already supported by the filesystem server's read_multiple_files tool, so batching adds less value there.

## What the accuracy result means

Both direct failures were the 300-incident count: answers 0 and 2, expected 7. Gateway returned 7 twice. The second direct agent explicitly confirmed seeing a truncation marker and not seeing the full corpus. The first direct agent's visible transcript is unavailable for a comparable post-run audit. Therefore this is an end-to-end result under this host's output limits, not a fair isolated model-reasoning accuracy comparison on a complete dataset.

The filesystem MCP duplicates file data in content and structuredContent. Its incident-file RPC response contained about 124k o200k tokens before host truncation. Raw daemon logs measure what the server returned, not what the model consumed. Large direct payload/context and cost proxies must not be described as actual context or billed usage. Gateway filtering avoided that large response reaching the host.

## Usage and cost comparison

The runtime exposes no actual Luna input/output/reasoning usage or bill. At a purely hypothetical $1/M input and $1/M output, replaying complete logged payloads would give:

| Scenario across 12 runs per condition | Direct | Gateway |
|---|---:|---:|
| Cumulative input proxy | 871,977 tokens | 220,380 tokens |
| Tool-request + answer output proxy | 851 tokens | 3,003 tokens |
| Normalized combined cost | $0.872828 | $0.223383 |
| Excluding both large-file questions (8 runs each) | $0.094214 | $0.106879 |

These scenario amounts assume complete payload replay, no caching, one decision per bridge operation, and exclude system/tool-wrapper/hidden-reasoning overhead. The direct large outputs were not all visible, so the apparent 74% overall scenario reduction is NOT demonstrated bill savings. On the eight small-task runs, the gateway's scenario cost was about 13% higher despite its smaller initial list. Fewer startup tokens alone do not guarantee cheaper complete answers.

## Questions asked

1. Read config.json: what is defaultRegion?
2. Find the Inventory Ledger recovery runbook: what is its verification metric?
3. Count open SEV2 incidents created from 2026-01-08 inclusive through 2026-01-12 exclusive.
4. Find INC-0003, then use memory to identify its service's owner team.
5. Read services.json and config.json: return the tier-0 service and SEV2 paging threshold.
6. Follow Checkout API's reads_from edge, then depends_on; find the final service's runbook and return its first action.

Exact prompts and scoring answers are in ../../questions.json. Agents received prompts without answers. The numeric JSON examples use 0 as a type example in both conditions; future benchmarks should use explicit type descriptions to avoid possible anchoring.

## Scope and audit

This is a small synthetic pilot against eager schemas, not Copilot deferred tools, and not a native MCP tool-injection integration. Both arms use the same generic shell bridge; external shell processing is forbidden, while gateway execute can process data. Results do not establish savings versus a coding agent that already filters data in its own shell.

Four-way concurrency, non-random question families, two repetitions, a session interruption and uncontrolled hosted model scheduling limit timing inference. One incomplete q1 gateway attempt was archived then restarted; completed wrong answers were retained. Duplicate daemon log entries with identical request IDs are deduplicated for analysis; raw entries remain in audit.json.gz. The audit archive includes prompts, run configurations/expected answers, full RPC responses, final answers, order and fixture metadata. No private production data or credentials were used.

See REPORT.md for per-question timings and payloads, runs.csv and summary.json for machine-readable metrics, and ../../PLAN.md for reproduction instructions. Source package-lock pins the installed dependencies. Live vendor OAuth, actual billing, remote services, and native deferred discovery remain untested here.

## Decision

Keep developing the filtering/composition use case, especially for large responses. Do not advertise the current prototype as universally faster or cheaper. Next experiments should add a native deferred-tools baseline and real usage telemetry; next product improvements should reduce schema expansion and help small models use execute correctly on the first attempt.
