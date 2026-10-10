# Structured single-call follow-up: 12 additional Luna runs

The final gateway has a median of 10.66 seconds across 12 fresh runs, with 12/12 correct answers. The previous gateway control in the preceding 36-run experiment had a median of 17.09 seconds; direct MCPs had 8.28 seconds. The observed differences are about 38% lower than the prior gateway and 29% higher than direct. This final pass was sequential after the controls, not interleaved again, so these percentages are descriptive and not a controlled causal estimate.

| Condition | Median elapsed | Correct | Initial tool-list bytes | Initial token proxy |
|---|---:|---:|---:|---:|
| Previous gateway, earlier control | 17.09 s | 12/12 | 2,008 | 458 |
| Inline catalogue, preceding experiment | 13.03 s | 12/12 | 4,657 | 1,117 |
| Final gateway, structured-call option | 10.66 s | 12/12 | 5,128 | 1,231 |
| Direct MCPs, earlier control | 8.28 s | 10/12 | 13,179 | 2,749 |

The final initial list is 61% smaller in bytes than direct eager schemas. It is larger than the previous gateway, deliberately exchanging bounded initial hints for fewer discovery turns. Token proxies are not actual model context, usage or bills.

## Changes and behavior

The gateway retains exactly two public tools. Small catalogues are represented as compact argument signatures in execute's description, capped at 4 KiB and 64 tools. Optional inlineTools selects up to five common tools in a larger setup; omitted means automatic mode, [] disables inline hints. This setting is not an authorization policy.

For a single operation, execute accepts {call:{server,tool,args}}. That request is data, not JavaScript. It uses the host upstream adapter, parses textual JSON when possible, preserves ordinary text/non-text content, and bounds raw and final results. Choose code instead for filtering or composition. The sandbox/raw mcp.call interface remains available and backward-compatible.

This final agent pass exercised the default inline catalogue and structured-call option. The selected working set was tested functionally but not separately benchmarked with hundreds of live upstreams. Larger auto catalogues still require discovery and do not receive the same speed benefit. Upstream discovery now contributes to startup, and cold upstream time is included in elapsed measurements.

## Per-question median

| Question | Final gateway |
|---|---:|
| filesystem-memory-join | 9.86 s |
| large-filter-aggregation | 20.65 s |
| multi-hop-dependency-runbook | 12.00 s |
| parallel-small-reads | 9.61 s |
| small-direct-lookup | 9.01 s |
| unfamiliar-file-search | 14.60 s |

## Limits of the result

There were 41 tool calls and 13 tool errors across the final 12 runs. Every run recovered to a correct answer, but the new interface did not eliminate model misuse. In particular, final small-lookup, two-read and large-filter medians were worse than the preceding inline-only pass. The aggregate median improved, not every task. We should not claim the structured option alone caused the improvement.

All 36 project tests pass, covering bounded deterministic signature rendering, refresh on config replacement, working-set validation/preservation, cleanup when removing an upstream, structured calls, output bounds and compatibility, plus existing sandbox/OAuth/integration checks. No security audit or live vendor OAuth test was added. The structured route does not execute code, but it still allows whatever upstream operations the configured credentials permit. Host-side permissions and approvals remain unimplemented.

The six original questions, two repetitions, gpt-6-luna medium reasoning, synthetic fixtures, same two official MCP packages, fresh sessions, up to four workers and 12-call cap were retained. No completed wrong answers were rerun. Hidden reasoning, exact billed tokens/costs and native deferred-tool client behavior are unavailable. Direct large outputs can be truncated by the host; the wrong direct counts cannot be interpreted as a complete-data reasoning comparison. Timing starts at first list request, ends at finish request and includes cold setup and bridge overhead, but excludes scheduling before that first list.

The data supports a useful latency reduction versus our earlier search-first gateway, not parity with direct MCPs or a production guarantee. See [research/design](../../../docs/latency-design.md), [36-run comparison](../inline-v3/README.md), REPORT.md, runs.csv, summary.json and audit.json.gz. The raw archive contains prompts, scoring configurations, full recorded responses and answers; all fixture data is synthetic.
