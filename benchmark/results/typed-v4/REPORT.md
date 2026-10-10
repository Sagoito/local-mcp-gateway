# Benchmark analysis

See [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: 12. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.

| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 0 | 0 | 0 | n/a | n/a | n/a | n/a tokens |
| gateway | 12 | 0 | 0 | 100.0% | 10661.0 ms | 28.0 ms | 2171.5 tokens |

Paired complete runs: 0. Paired pass-rate difference (gateway minus direct): n/a. This is descriptive only; two repetitions per question cannot support statistical significance claims.

## Per-question results

| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---|---:|---:|---:|---:|---:|
| filesystem-memory-join | gateway | 2 / 2 | 100.0% | 9864.5 ms | 76.0 ms | 2244.5 tokens |
| large-filter-aggregation | gateway | 2 / 2 | 100.0% | 20651.0 ms | 121.5 ms | 2444.5 tokens |
| multi-hop-dependency-runbook | gateway | 2 / 2 | 100.0% | 12004.5 ms | 28.0 ms | 2145.5 tokens |
| parallel-small-reads | gateway | 2 / 2 | 100.0% | 9611.0 ms | 11.0 ms | 2702 tokens |
| small-direct-lookup | gateway | 2 / 2 | 100.0% | 9013.5 ms | 11.5 ms | 1888.5 tokens |
| unfamiliar-file-search | gateway | 2 / 2 | 100.0% | 14601.5 ms | 35.0 ms | 2132.5 tokens |

## Timing and cost interpretation

The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.

Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision, adding definitions after list returns. Both exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.

The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.
