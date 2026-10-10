# Many-MCP context scaling pilot

Prespecified on 2026-10-09 before measurement. Question: does the context benefit grow with many configured MCPs?

## Catalogue measurement

Use actual installed official filesystem/memory MCP stdio server processes, two server types replicated as distinct configured endpoints with isolated data. Counts: 2, 8, 16, 32 servers (1, 4, 8, 16 pairs). Primary aliases and fixtures remain filesystem/memory; auxiliary server aliases are distinguishable, their data separate, and no credentials or network services are used. This is a replicated-server scaling test, not 32 distinct MCP vendors or OAuth integrations.

For every scale record the complete direct tools/list definition payload and the gateway's tools/list payload in (a) default two-tool discovery mode and (b) the same five-tool native profile as query-v6. Do not invent schemas or extrapolate multiplying a small sample. Start actual MCP processes, verify expected tool counts, retain raw lists and report UTF-8 bytes and o200k_base token proxies. Test default/no-native limits and the selected-native budget separately. Record connection/list startup time as diagnostic only; context is the primary outcome. Batches of four direct connections/lists match the gateway discovery concurrency.

## Agent validation

Run six unchanged questions × two repetitions × direct/gateway = 24 fresh gpt-6-luna agents, medium reasoning, against the 32-server setup. At most two benchmark workers concurrently to control resource pressure from up to 64 actual upstream processes. Rotate condition order using existing prepare logic. Freeze gateway/harness hashes before dispatch. The same five native tools are selected for every question; remaining schemas are discoverable. No task-specific aliases, tool definitions, answers or filters.

Retain all completed outcomes, including failures. An externally interrupted incomplete worker may be archived with a documented reason and freshly replaced; no completed wrong answer may be retried. Expected answers/configs stay outside agent prompts. Both arms use the same generic bridge, original twelve-call cap and installed MCP versions. Solver code cannot read/process data outside the exposed MCP interface.

## Reporting

Primary: initial definition bytes/token proxies at each scale. Agent validation: correctness, tool calls/errors, median accumulated payload proxy, replayed input proxy and elapsed times including cold startup. Report startup separately: reducing model-visible definitions does not imply less host memory or fewer upstream connections. Publish manifests, raw tool lists, agent logs and reproducible scripts.

These are payload measurements, not actual provider-reported context or billed costs. No provider billing/hidden reasoning is available. The generic shell bridge differs from native model tool registry injection. Full daemon payload may be larger than model-visible content if host output is truncated; audit truncation markers where available. Direct large-file output was truncated in prior pilots. Two repetitions per question are descriptive, not statistically conclusive. This does not compare a native deferred-tool client or prove compatibility/performance for real authenticated third-party services. Single-vendor diversity, CPU pressure, eager upstream discovery and curated native-tool selection remain limitations.

## Documented adaptation after catalogue measurement

The full 32-server catalogue measures 44,959 o200k_base token proxies. During the first six agent runs, direct workers reported a visible `…4396 tokens truncated…` marker and could not see the primary tools, despite requesting both functions.exec and exec_command budgets of 70,000. The root's internal retrieval can parse all 368 tools, so the exact truncation layer is unresolved. Those six completed outcomes are retained separately; the remaining 18 original planned runs are not dispatched and no 32-server agent performance claim is made.

A fresh 24-run paired agent validation was prepared at 16 servers (184 tools, 22,447 initial token proxies), initially expected to fit the display path. That expectation was subsequently disproved by the worker observations below. All four catalogue scales remain measured, including 32. This change of experimental setup did not retry completed wrong answers.

## Display-path validation

The 16-server monolithic list also showed a visible truncation marker in direct workers, despite budgets70,000; the first four outcomes (two questions × two conditions) remain separately retained. No fair monolithic-list agent comparison is claimed at either size. Root can internally parse the full lists, so catalogue size measurements remain intact.

Before further task validation, add deterministic catalogue-only pages bounded at12,000UTF-8bytes with complete schema objects. List pagination is harness instrumentation, not a product change. A dedicated Luna delivery audit must confirm all page outputs are visible and primary server definitions present. Each page is emitted as a separate tool content block. If those blocks fit, use a fresh trial with the full original catalogue, tracking page delivery explicitly. Full payload is counted once across pages; paging overhead and time are reported separately. Completed outcomes from prior layouts are preserved and never substituted with successes. This delivery adaptation is a limitation of the generic bridge and is not an argument for production speed or actual provider billing savings.

## Final scope after delivery audit

All 19 catalogue pages in one functions.exec invocation still clipped: four full pages and a partial fifth were visible, followed by 14 omitted text items. Seven invocations with at most three pages each delivered every complete schema, including both primary server definitions. This would add multiple orchestration/model turns to the direct condition, preventing a fair native tool-registry latency comparison. No third task pilot was dispatched. Publish the valid complete catalogue measurements at all four scales, retain all ten completed outcomes from the two aborted layouts, and report the large-catalogue latency/usage comparison as unresolved. Paged preparation remains diagnostic tooling; its cumulative-input estimate is unavailable rather than inferred from page RPCs.
