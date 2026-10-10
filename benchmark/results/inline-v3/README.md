# Bounded inline catalogue: 36-run comparison

Three conditions, six unchanged tasks, two fresh Luna agents per condition/task. Previous gateway is compiled from commit 6f09ea5. All arms include cold connection time and use the same mailbox harness.

| Condition | Median elapsed | Correct | Initial list bytes |
|---|---:|---:|---:|
| Direct | 8.28 s | 10/12 | 13,179 |
| Previous gateway | 17.09 s | 12/12 | 2,008 |
| Inline catalogue | 13.03 s | 12/12 | 4,657 |

Inline median was 23.7% lower than the contemporaneous previous-gateway control, but still 57.4% above direct MCPs. The two-tool initial list was 64.7% smaller in bytes than direct schemas, at the cost of being larger than the previous gateway list.

| Question | Previous gateway | Inline catalogue | Direct |
|---|---:|---:|---:|
| filesystem-memory-join | 19.80 s | 15.66 s | 7.11 s |
| large-filter-aggregation | 23.27 s | 14.58 s | 12.07 s |
| multi-hop-dependency-runbook | 19.36 s | 11.55 s | 11.42 s |
| parallel-small-reads | 8.95 s | 7.83 s | 5.67 s |
| small-direct-lookup | 12.44 s | 7.38 s | 4.62 s |
| unfamiliar-file-search | 16.58 s | 16.74 s | 9.68 s |

Gateway tool calls dropped from 58 to 39, but tool errors were 10 versus 11: exposing signatures removed discovery without reliably preventing malformed code or incorrect outer tool names. This motivated a subsequent structured-call experiment, reported separately.

Caveats: n=2 per task, up to four concurrent agents, synthetic data, generic bridge rather than native MCP tool injection, and no actual model token/billing telemetry. Direct large-file payload may be truncated by the host, as confirmed in an earlier pilot; both current direct incident counts were wrong. Logged payload is not proof of model-visible content. The schema byte tradeoff is intentional. Large auto catalogues fall back to discovery, so these timings do not imply the same benefit for hundreds of tools.

Two controller dispatch mistakes delayed the control q1 repetition 2 and inline q6 repetition 2. They were completed afterward with fresh agents; no completed wrong answers were rerun. All 36 expected answer files exist. Request files were atomically claimed; raw traces had no duplicate request IDs. The analyzer now uses the first completed attempt and preserves any later trace entries only in the archive.

The measured compiled gateway was frozen. Explicit user-selected inlineTools was added afterward and tested functionally, but this benchmark measures the automatic complete-catalogue mode. Source and control artifact hashes plus intended order are in manifest.json. Raw prompts, configs, answers and RPC results are in audit.json.gz. All data is synthetic; there are no production credentials.

[Research and method](../../../docs/latency-design.md). For original per-run analysis see current/ and control/. Their payload proxies and hypothetical price-normalized scenarios are not measured usage or actual costs.
