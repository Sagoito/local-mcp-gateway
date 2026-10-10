# Structured retained-result latency pilot

The final 24-run pilot uses two official local MCP servers and fresh gpt-6-luna agents. The gateway reached near-direct aggregate speed without a host-language rewrite. See [prespecified plan](../../QUERY_PLAN.md), [questions](../../questions.json), [full report](REPORT.md), [run table](runs.csv), [summary](summary.json), [manifest](manifest.json) and [raw audit](audit.json.gz).

## Results

| Metric | Direct MCPs | Native + structured-query gateway |
|---|---:|---:|
| Median answer time | 9.52 s | 7.80 s |
| Mean answer time | 9.27 s | 8.01 s |
| Correct answers | 10/12 | 12/12 |
| Tool calls | 24 | 29 |
| Tool errors | 0 | 0 |
| Initial definitions | 13,179 bytes | 7,390 bytes |
| Initial definition token proxy | 2,749 | 1,647 |
| Median total tool-call RPC time | 12.5 ms | 21 ms |
| Median cold setup RPC time | 350.5 ms | 416 ms |

Descriptively, the gateway median was 18.0% lower and mean 13.6% lower than the contemporaneous direct control. This meets the prespecified aggregate within-10% latency goal. It does not prove every task is faster or establish production parity. Five question medians were faster; the filesystem/memory join still took 10.40 s versus 7.78 s because the gateway retains the large response, filters in another turn, then queries memory. Both join answers were correct. Large filtering took 9.82 s versus 14.31 s; both direct counts were wrong and both gateway counts correct. Complete per-question results remain visible in REPORT.md.

## What was slow and what changed

The earlier typed gateway spent a median 28 ms in tool-call RPCs but incurred 13 errors in 12 tasks. Agents tried discovered names as exposed tools, refetched oversized data after size-limit errors, and guessed arrays incorrectly. Native-v5 removed most of that with five actual native aliases and retained-result handles, reaching 7.50 s median versus 8.30 s direct, but one join still suffered four code-quoting errors and took 28.25 s.

This build adds a data-only `execute.result` query over a retained JSON snapshot. It supports array paths, AND scalar comparisons, all/first/count and field selection, with own-property traversal, 100,000-record and 1,000,000-visit limits and 32 KiB output. The query does not evaluate generated JavaScript or invoke another upstream call. All four completed gateway large-file tasks used this structured route; none used custom code. Native single operations also avoid generated code. Custom composition still has optional isolated QuickJS execution.

The remaining eight-millisecond difference in median total call-RPC time is much smaller than the seconds consumed by an extra model/bridge turn. TypeScript/Node is therefore not the principal observed bottleneck. This is an inference from these traces, not a Go/Rust performance comparison. Native definitions preserve upstream argument schemas and annotations; upstream servers validate arguments. Public tools are search, execute and the same five curated tools for every task, sharing an 8 KiB native-definition cap. Adding more upstream tools does not increase that native budget. Automatic inline signatures are disabled for this profile; the default two-tool profile is not the measured mode.

## Context, usage and cost proxies

Initial definition bytes fell 43.9%; initial definition token proxy fell 40.1%. Median accumulated payload proxy was 2,530 versus 4,278.5 tokens. Cumulative replayed input proxy was 102,134 gateway versus 875,248 direct, and output proxy 1,281 versus 867. At hypothetical $1/M per input/output side, scenario totals are $0.103415 and $0.876115. These are **not actual model context, usage, prices or billed costs**. Large duplicated direct responses dominate much of the replayed proxy and were truncated by the host. Provider usage and hidden reasoning are unavailable, so no billed savings are established.

## Method and limitations

Six unchanged questions, two repetitions per condition, fresh medium-reasoning Luna agents and at most four benchmark workers. Condition order alternates. Both conditions use the same bridge, fixtures, official filesystem/memory MCP versions, and twelve-call cap. Expected answers stay out of agent prompts. The five-tool profile was informed by earlier traces and curated across all questions, not chosen per task or automatically inferred for arbitrary MCPs. Source and compiled hashes were frozen before dispatch and verified unchanged afterward.

One gateway join worker was interrupted by user steering after reading/querying data, before completing its answer. Its incomplete timed trace is preserved separately in the audit and manifest. The coordinator closed it with an interruption marker and ran a fresh replacement. No completed wrong answer was retried. All 24 measured runs completed; no duplicate event IDs or post-finish events were found. Replacement scheduling is a documented deviation.

Two repetitions per task cannot establish statistical significance or guaranteed latency. Times span first list request to finish-request start, include cold setup and generic shell orchestration, and exclude initial worker scheduling. This is not native model tool-registry injection or a Copilot deferred-tools baseline. Large direct output truncation prevents treating logged data as exact visible context, and direct inaccurate answers are not equivalent successful work. Vendor OAuth, remote upstream performance, adversarial production deployment, resource/prompt/sampling proxying, and authorization policies are not tested. Retained results are bounded in-memory snapshots and clear on config replacement/disconnect; the gateway does not add host-side operation permissions or approvals.

## Reproduce

```sh
npm ci
npm run build
node benchmark/prepare.mjs /absolute/path/to/new-runs --native
node benchmark/daemon.mjs /absolute/path/to/new-runs
```

Run each generated prompt with a fresh Luna agent following order.json and the four-worker cap. Then run `node benchmark/analyze.mjs /absolute/path/to/new-runs /absolute/path/to/new-report`. A different client/model/profile may behave differently. Verification: build and all 58 automated tests pass.
