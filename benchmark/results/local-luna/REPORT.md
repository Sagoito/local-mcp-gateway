# Benchmark analysis

See [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: 24. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.

| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 12 | 0 | 0 | 83.3% | 7849.0 ms | 11.0 ms | 4286.5 tokens |
| gateway | 12 | 0 | 0 | 100.0% | 19827.5 ms | 322.0 ms | 3590 tokens |

Paired complete runs: 12. Paired pass-rate difference (gateway minus direct): 16.7 percentage points. This is descriptive only; two repetitions per question cannot support statistical significance claims.

## Per-question results

| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---|---:|---:|---:|---:|---:|
| filesystem-memory-join | direct | 2 / 2 | 100.0% | 7762.5 ms | 15.5 ms | 127477 tokens |
| filesystem-memory-join | gateway | 2 / 2 | 100.0% | 27032.5 ms | 382.5 ms | 7186.5 tokens |
| large-filter-aggregation | direct | 2 / 2 | 0.0% | 14772.5 ms | 11.0 ms | 127218 tokens |
| large-filter-aggregation | gateway | 2 / 2 | 100.0% | 27712.5 ms | 464.0 ms | 3151 tokens |
| multi-hop-dependency-runbook | direct | 2 / 2 | 100.0% | 13715.0 ms | 20.5 ms | 4022.5 tokens |
| multi-hop-dependency-runbook | gateway | 2 / 2 | 100.0% | 22119.0 ms | 324.0 ms | 3604 tokens |
| parallel-small-reads | direct | 2 / 2 | 100.0% | 5144.0 ms | 5.0 ms | 4550 tokens |
| parallel-small-reads | gateway | 2 / 2 | 100.0% | 7695.0 ms | 316.0 ms | 3979.5 tokens |
| small-direct-lookup | direct | 2 / 2 | 100.0% | 5299.0 ms | 5.5 ms | 3451 tokens |
| small-direct-lookup | gateway | 2 / 2 | 100.0% | 8759.5 ms | 274.0 ms | 2776 tokens |
| unfamiliar-file-search | direct | 2 / 2 | 100.0% | 8029.5 ms | 12.0 ms | 3899 tokens |
| unfamiliar-file-search | gateway | 2 / 2 | 100.0% | 17915.0 ms | 313.0 ms | 3360.5 tokens |

## Timing and cost interpretation

The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.

Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision, adding definitions after list returns. Both exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.

The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.
