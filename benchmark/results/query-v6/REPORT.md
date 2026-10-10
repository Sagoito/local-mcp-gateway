# Benchmark analysis

See [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: 24. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.

| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 12 | 0 | 0 | 83.3% | 9517.0 ms | 12.5 ms | 4278.5 tokens |
| gateway | 12 | 0 | 0 | 100.0% | 7802.5 ms | 21.0 ms | 2530 tokens |

Paired complete runs: 12. Paired pass-rate difference (gateway minus direct): 16.7 percentage points. This is descriptive only; two repetitions per question cannot support statistical significance claims.

## Per-question results

| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---|---:|---:|---:|---:|---:|
| filesystem-memory-join | direct | 2 / 2 | 100.0% | 7779.0 ms | 15.0 ms | 127472 tokens |
| filesystem-memory-join | gateway | 2 / 2 | 100.0% | 10402.5 ms | 37.5 ms | 2756 tokens |
| large-filter-aggregation | direct | 2 / 2 | 0.0% | 14309.0 ms | 10.5 ms | 127213 tokens |
| large-filter-aggregation | gateway | 2 / 2 | 100.0% | 9820.0 ms | 22.0 ms | 2530 tokens |
| multi-hop-dependency-runbook | direct | 2 / 2 | 100.0% | 12185.5 ms | 19.0 ms | 4017.5 tokens |
| multi-hop-dependency-runbook | gateway | 2 / 2 | 100.0% | 10729.5 ms | 26.0 ms | 2529.5 tokens |
| parallel-small-reads | direct | 2 / 2 | 100.0% | 6682.0 ms | 6.0 ms | 4539 tokens |
| parallel-small-reads | gateway | 2 / 2 | 100.0% | 5731.0 ms | 9.0 ms | 3061.5 tokens |
| small-direct-lookup | direct | 2 / 2 | 100.0% | 5154.5 ms | 6.0 ms | 3446 tokens |
| small-direct-lookup | gateway | 2 / 2 | 100.0% | 3993.0 ms | 8.0 ms | 2198 tokens |
| unfamiliar-file-search | direct | 2 / 2 | 100.0% | 9531.0 ms | 13.0 ms | 3956 tokens |
| unfamiliar-file-search | gateway | 2 / 2 | 100.0% | 7397.5 ms | 19.0 ms | 2491.5 tokens |

## Timing and cost interpretation

The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.

Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision, adding definitions after list returns. Both exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.

The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.
