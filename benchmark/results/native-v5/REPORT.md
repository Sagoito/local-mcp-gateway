# Benchmark analysis

See [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: 24. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.

| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 12 | 0 | 0 | 91.7% | 8304.5 ms | 14.0 ms | 4278 tokens |
| gateway | 12 | 0 | 0 | 100.0% | 7500.5 ms | 24.0 ms | 2242 tokens |

Paired complete runs: 12. Paired pass-rate difference (gateway minus direct): 8.3 percentage points. This is descriptive only; two repetitions per question cannot support statistical significance claims.

## Per-question results

| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |
|---|---|---:|---:|---:|---:|---:|
| filesystem-memory-join | direct | 2 / 2 | 100.0% | 9305.5 ms | 16.0 ms | 127472 tokens |
| filesystem-memory-join | gateway | 2 / 2 | 100.0% | 19680.0 ms | 87.5 ms | 2750 tokens |
| large-filter-aggregation | direct | 2 / 2 | 50.0% | 18994.5 ms | 22.0 ms | 189451.5 tokens |
| large-filter-aggregation | gateway | 2 / 2 | 100.0% | 8865.0 ms | 57.5 ms | 2182.5 tokens |
| multi-hop-dependency-runbook | direct | 2 / 2 | 100.0% | 11425.0 ms | 18.0 ms | 4016.5 tokens |
| multi-hop-dependency-runbook | gateway | 2 / 2 | 100.0% | 11014.5 ms | 32.0 ms | 2284 tokens |
| parallel-small-reads | direct | 2 / 2 | 100.0% | 6147.5 ms | 7.0 ms | 4539 tokens |
| parallel-small-reads | gateway | 2 / 2 | 100.0% | 6836.5 ms | 11.0 ms | 2792 tokens |
| small-direct-lookup | direct | 2 / 2 | 100.0% | 5052.5 ms | 5.0 ms | 3446 tokens |
| small-direct-lookup | gateway | 2 / 2 | 100.0% | 5326.5 ms | 8.5 ms | 1934 tokens |
| unfamiliar-file-search | direct | 2 / 2 | 100.0% | 7333.0 ms | 17.0 ms | 3748.5 tokens |
| unfamiliar-file-search | gateway | 2 / 2 | 100.0% | 6922.5 ms | 17.5 ms | 2200 tokens |

## Timing and cost interpretation

The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.

Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision, adding definitions after list returns. Both exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.

The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.
