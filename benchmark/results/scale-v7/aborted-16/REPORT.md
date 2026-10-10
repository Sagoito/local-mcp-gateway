# Benchmark analysis

**This layout was aborted because the direct catalogue was visibly truncated. The following generated metrics are diagnostic only and do not establish a fair full-catalogue comparison.**

See [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: 24. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.

| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 2 | 10 | 0 | 50.0% | 28177.0 ms | 36.5 ms | 24140 tokens |
| gateway | 2 | 10 | 0 | 100.0% | 8776.5 ms | 16.0 ms | 2372.5 tokens |

Paired complete runs: 2. Paired pass-rate difference (gateway minus direct): 50.0 percentage points. This is descriptive only; two repetitions per question cannot support statistical significance claims.

## Per-question results

| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---|---:|---:|---:|---:|---:|
| filesystem-memory-join | direct | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| filesystem-memory-join | gateway | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| large-filter-aggregation | direct | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| large-filter-aggregation | gateway | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| multi-hop-dependency-runbook | direct | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| multi-hop-dependency-runbook | gateway | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| parallel-small-reads | direct | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| parallel-small-reads | gateway | 0 / 2 | n/a | n/a | n/a | n/a tokens |
| small-direct-lookup | direct | 1 / 2 | 100.0% | 27894.0 ms | 37.0 ms | 24068 tokens |
| small-direct-lookup | gateway | 1 / 2 | 100.0% | 5856.0 ms | 9.0 ms | 2240 tokens |
| unfamiliar-file-search | direct | 1 / 2 | 0.0% | 28460.0 ms | 36.0 ms | 24212 tokens |
| unfamiliar-file-search | gateway | 1 / 2 | 100.0% | 11697.0 ms | 23.0 ms | 2505 tokens |

## Timing and cost interpretation

The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.

Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision for unpaged runs. In paged runs, the full definition payload is counted once, while cumulative input is unavailable because catalogue pages are delivered across multiple grouped model turns. Catalogue delivery RPC time sums page RPC durations; catalogue delivery elapsed time spans the first page request start through the final page response; post-catalogue task time runs from that response to finish. These exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.

The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.
