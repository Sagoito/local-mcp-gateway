# Bounded native tool latency pilot

Prespecified before runs, 2026-10-09. Goal: approach direct-MCP end-to-end latency by removing discovery mistakes and oversized-result retries. This builds on trace profiling from typed-v4, where the median sum of gateway tool RPC time was only 28 ms but agents made 41 calls and 13 errors across 12 tasks.

## Design

- Six unchanged questions in questions.json; two repetitions per condition = 24 fresh gpt-6-luna agents, medium reasoning, at most four active benchmark workers.
- Alternate direct and gateway ordering for each question/repetition using prepare.mjs; no retries of completed wrong answers. Coordinator errors must be recorded, not silently deleted.
- Both arms use the same generic bridge, official filesystem/memory MCP versions, fixture contents, user prompts and twelve-call cap. Filesystem reads must use MCP; memory questions must use memory MCP.
- Direct advertises the complete upstream catalog. Gateway explicitly selects five common tools: read_text_file, search_files, read_multiple_files, search_nodes and list_directory. The working set is identical for every task and informed by earlier pilot traces. This is a curated profile, not automatic tool selection or a strict two-tool gateway.
- Gateway keeps two meta tools plus at most five full native schemas, total native definitions at most 8 KiB. Native schema JSON is preserved; validation happens at upstream. Omitted tools remain searchable/callable through execute. Automatic inline hints are disabled when this native working set is configured.
- Responses over 32 KiB are retained with bounded shape metadata; agents can use mcp.result(handle) inside QuickJS to filter without an additional upstream read. Handles have five-minute TTL, eight-entry and 8 MiB total limits, and are revoked on config replacement/disconnect.
- Freeze compiled gateway before dispatch. Record source/compiled hashes, config, tool list and raw request/response events. Do not edit measured code mid-run.

## Outcomes

Report median and per-question end-to-end time, exact answer scores, RPC time including cold setup, tool call/error count, and payload byte/token proxies. A pilot gap within 10% of direct is the working target; question-level regressions and larger cases must remain visible. Do not tune around final answers or run counts after seeing results.

No actual provider usage/billing or hidden reasoning is available. o200k_base payload counts and hypothetical $1/M input/output units are not billed costs. Host truncation of large direct outputs may lower direct accuracy while inflating logged payload proxies. Same bridge in both arms controls orchestration, but does not benchmark native model tool registry injection, production clients or current Copilot deferral. Two repetitions per question are descriptive, not statistical evidence of guaranteed parity.
