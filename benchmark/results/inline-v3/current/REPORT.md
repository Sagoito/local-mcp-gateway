# Benchmark analysis

See [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: 24. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.

| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 12 | 0 | 0 | 83.3% | 8277.0 ms | 12.5 ms | 4311.5 tokens |
| gateway | 12 | 0 | 0 | 100.0% | 13032.0 ms | 52.5 ms | 2462 tokens |

Paired complete runs: 12. Paired pass-rate difference (gateway minus direct): 16.7 percentage points. This is descriptive only; two repetitions per question cannot support statistical significance claims.

## Per-question results

| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---|---:|---:|---:|---:|---:|
| filesystem-memory-join | direct | 2 / 2 | 100.0% | 7111.0 ms | 20.0 ms | 127472 tokens |
| filesystem-memory-join | gateway | 2 / 2 | 100.0% | 15664.0 ms | 74.0 ms | 5398.5 tokens |
| large-filter-aggregation | direct | 2 / 2 | 0.0% | 12069.5 ms | 9.0 ms | 127213 tokens |
| large-filter-aggregation | gateway | 2 / 2 | 100.0% | 14583.5 ms | 77.0 ms | 1944.5 tokens |
| multi-hop-dependency-runbook | direct | 2 / 2 | 100.0% | 11424.0 ms | 18.0 ms | 4050 tokens |
| multi-hop-dependency-runbook | gateway | 2 / 2 | 100.0% | 11554.0 ms | 49.5 ms | 2532.5 tokens |
| parallel-small-reads | direct | 2 / 2 | 100.0% | 5671.5 ms | 5.5 ms | 4539 tokens |
| parallel-small-reads | gateway | 2 / 2 | 100.0% | 7833.0 ms | 30.0 ms | 2598.5 tokens |
| small-direct-lookup | direct | 2 / 2 | 100.0% | 4615.5 ms | 5.0 ms | 3446 tokens |
| small-direct-lookup | gateway | 2 / 2 | 100.0% | 7380.0 ms | 31.5 ms | 1794 tokens |
| unfamiliar-file-search | direct | 2 / 2 | 100.0% | 9682.5 ms | 17.0 ms | 4000.5 tokens |
| unfamiliar-file-search | gateway | 2 / 2 | 100.0% | 16739.0 ms | 59.5 ms | 2471 tokens |

## Timing and cost interpretation

The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.

Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision, adding definitions after list returns. Both exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.

The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.
