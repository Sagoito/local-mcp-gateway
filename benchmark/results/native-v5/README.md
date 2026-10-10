# Native common-tool latency pilot

All 24 fresh Luna runs completed: six unchanged tasks, two repetitions, direct MCP versus a configured five-tool native profile. See [prespecified plan](../../NATIVE_PLAN.md), [question list](../../questions.json), [full report](REPORT.md), [run table](runs.csv), [summary](summary.json), [manifest](manifest.json) and [raw audit](audit.json.gz).

## Result

| Metric | Direct MCPs | Native gateway |
|---|---:|---:|
| Median answer time | 8.30 s | 7.50 s |
| Mean answer time | 9.71 s | 9.77 s |
| Correct answers | 11/12 | 12/12 |
| Tool calls | 25 | 33 |
| Tool errors | 0 | 4 |
| Initial definitions | 13,179 bytes | 6,347 bytes |
| Initial definition token proxy | 2,749 | 1,383 |
| Median total tool-call RPC time | 14 ms | 24 ms |
| Median cold setup RPC time | 364.5 ms | 434.5 ms |

The median meets the pilot's within-10% goal, and mean latency is within 1%, but this does not establish parity for every task. In the filesystem/memory join the gateway's question median is 19.68 s versus 9.31 s direct. One run took 28.25 s: code quoting errors caused four failed executions, then a repeat fetch and two memory queries. The other join took 11.11 s. This outlier is retained in the mean and report, and motivates a structured retained-result filter rather than declaring all latency solved. Small lookup median was 5.33 s versus 5.05 s; parallel reads 6.84 s versus 6.15 s. Large filtering was 8.87 s versus 18.99 s, with one incorrect direct answer.

## Bottleneck and implementation

Earlier typed-v4 spent a median 28 ms in tool-call RPCs but had 13 errors over 12 tasks. Agents attempted discovered names as outer tools and repeatedly fetched oversized results or assumed wrong data shapes. This profile exposes actual native aliases with complete upstream argument schemas and retains large results with opaque handles plus a bounded shape summary. Common single operations now take one client call; large results can be filtered using mcp.result without another upstream fetch. There is no additional LLM or router service.

The same five user-selected tools are advertised for all tasks, plus search and execute. Native definitions share an 8 KiB cap, independent of catalogue size; automatic inline hints are disabled. This is a curated hot-tool profile informed by earlier pilots, not an automatic solution for every possible tool set and not a strict two-tool interface. The measured build is frozen and source/compiled hashes are in the manifest. No completed failures were rerun, no duplicate request IDs or coordinator deviations were found.

## Context, usage and costs

Initial definition bytes fell 51.8% and initial definition token proxy fell 49.7%. Median accumulated payload proxy was 2,242 versus 4,278 tokens. Cumulative replayed input proxy was 102,410 gateway versus 1,374,069 direct; output proxy 1,519 versus 913. At a hypothetical $1/M for each input/output side, the scenario totals are $0.103929 versus $1.374982. These are unpriced scenario units, **not actual model context, usage or billed costs**. Much of the direct cumulative proxy comes from large duplicated MCP results that the host truncates. No provider billing or hidden reasoning is available.

## Limits

Two repetitions per task are descriptive and cannot establish statistical significance or guaranteed production latency. End-to-end time starts at first list request and includes cold setup, generic shell bridge and model decisions; initial worker scheduling is excluded. Both modes use the same bridge, not native model tool registry injection or a Copilot deferral control. The quoting failures occur through that bridge and may differ in a native client. Direct large-file output truncation prevents treating its complete logged payload as visible context. OAuth vendor login, remote services and permission policies are not tested by this pilot. Native calls avoid code execution for single operations; optional custom QuickJS code still invokes configured upstream actions under their credentials.

## Reproduce

```sh
npm ci
npm run build
node benchmark/prepare.mjs /absolute/path/to/new-runs --native
node benchmark/daemon.mjs /absolute/path/to/new-runs
```

Run each generated prompt with a fresh Luna agent, respecting the order.json and four-worker cap. Then run `node benchmark/analyze.mjs /absolute/path/to/new-runs /absolute/path/to/new-report`. Do not let solver agents read configs or expected answers.
