# Benchmark analysis

See [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: 12. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.

| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 0 | 0 | 0 | n/a | n/a | n/a | n/a tokens |
| gateway | 12 | 0 | 0 | 100.0% | 17087.5 ms | 299.0 ms | 2610.5 tokens |

Paired complete runs: 0. Paired pass-rate difference (gateway minus direct): n/a. This is descriptive only; two repetitions per question cannot support statistical significance claims.

## Per-question results

| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---|---:|---:|---:|---:|---:|
| filesystem-memory-join | gateway | 2 / 2 | 100.0% | 19796.0 ms | 350.0 ms | 4873.5 tokens |
| large-filter-aggregation | gateway | 2 / 2 | 100.0% | 23275.0 ms | 348.0 ms | 3100 tokens |
| multi-hop-dependency-runbook | gateway | 2 / 2 | 100.0% | 19359.0 ms | 299.0 ms | 2929.5 tokens |
| parallel-small-reads | gateway | 2 / 2 | 100.0% | 8952.0 ms | 291.0 ms | 2372.5 tokens |
| small-direct-lookup | gateway | 2 / 2 | 100.0% | 12437.0 ms | 260.5 ms | 1622.5 tokens |
| unfamiliar-file-search | gateway | 2 / 2 | 100.0% | 16580.0 ms | 276.5 ms | 2463 tokens |

## Timing and cost interpretation

The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.

Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision, adding definitions after list returns. Both exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.

The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.
