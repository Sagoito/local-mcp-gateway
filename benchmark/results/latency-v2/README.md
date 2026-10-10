# Latency follow-up: modest median change, gap remains

24 fresh gpt-6-luna medium-reasoning runs, six unchanged questions × two repetitions × direct/gateway. Same official filesystem and memory MCP versions and deterministic fixtures as the first pilot. All 26 unit/integration tests pass.

| Metric | Original gateway | Updated gateway | Current direct control |
|---|---:|---:|---:|
| Median answer elapsed | 19.83 s | 18.33 s | 7.58 s |
| Correct answers | 12/12 | 12/12 | 11/12 |
| Agent tool calls | 68 | 62 | 24 |
| Tool errors | 11 | 9 | 0 |
| Initial tool-list bytes | 1,528 | 2,008 | 13,179 |
| Initial token proxy | 358 | 458 | 2,749 |
| Median accumulated payload token proxy | 3,590 | 3,119.5 | 4,332 |

The updated median was 7.5% lower than the historical gateway pilot, but still 2.42× current direct latency. This small, non-random hosted-agent experiment does not establish a statistically reliable speedup. Four question medians improved and two regressed. We have NOT solved the latency gap.

| Question | Original gateway | Updated gateway | Current direct |
|---|---:|---:|---:|
| Small lookup | 8.76 s | 7.04 s | 4.69 s |
| Runbook search | 17.92 s | 14.41 s | 9.42 s |
| Large filter/count | 27.71 s | 31.76 s | 20.26 s |
| Incident/ownership join | 27.03 s | 19.91 s | 7.58 s |
| Two small reads | 7.70 s | 12.51 s | 4.95 s |
| Dependency/runbook traversal | 22.12 s | 21.28 s | 11.12 s |

## Changes tested

Discovery supplies up to three argument schemas by default, with explicit compact-summary mode retained. Capability ranking discounts server-only tokens and deprecated tools. Instructions clarify that discovered tools are only callable within execute. New generic text, JSON and array helpers avoid repeatedly hand-parsing raw MCP wrappers; mcp.call remains unchanged. WASM module initialization is shared, with a fresh runtime/context per execution. The benchmark bridge writes request files atomically.

These changes reduce some unnecessary discovery turns but do not ensure agents compose operations correctly. The large-filter regression included returning the full file, hitting the output limit, extra searches, and parsing an already-parsed helper result again. There are no task-specific answers or field names in product code.

## Interpretation and limitations

The decisive remaining overhead is model round trips. Median summed tool RPC time is only 0.312 s for the gateway (excluding initial list); saving milliseconds there cannot close a multi-second agent gap. Useful next experiments: a bounded, user-selected set of ready-to-use tool schemas, warm multi-task sessions, or typed call/batch operations for simple tasks, with code reserved for composition/filtering. None is implemented by this patch.

Initial gateway tool-list bytes remain 84.8% below the direct eager list. Token figures measure logged payload, not actual model context, token usage or bills. At hypothetical $1/M input plus $1/M output, full-payload replay gives $0.210224 for the updated gateway versus $1.000564 direct across 12 runs each. Do not interpret that as actual spend or proven savings: direct large output can be truncated by the host, and hidden reasoning, tool framing and caching are unmeasured. One current direct count was wrong and one correct. Post-run truncation audits were unavailable; the historical audit confirmed truncation. This still is not a native deferred-tool comparison.

Full raw logs preserve duplicate entries; analysis deduplicates request IDs and uses first completed finish. Repeated completion logs introduce additional background activity, so timings are noisy. Up to four benchmark workers ran concurrently; one brief project test suite also ran during the final batch. Historical and current batches used separate hosted sessions. Gateway code and fixtures were frozen throughout the current runs. Small n=2 per question prevents broad claims.

Security is separate from performance: these were read-only synthetic tasks, not adversarial security tests. The current gateway has resource-bounded JavaScript but no host-side tool allowlists, per-operation approvals or argument policy. Upstream processes run with OS permissions outside QuickJS. Do not use these results as evidence of safe unrestricted access to sensitive MCPs.

See [follow-up plan](../../LATENCY_PLAN.md), REPORT.md, runs.csv, summary.json, comparison.json and audit.json.gz. Re-run comparison with `node benchmark/compare.mjs benchmark/results/local-luna/summary.json benchmark/results/latency-v2/summary.json`.
