# Discovery and parsing latency follow-up

Repeat the original six questions, two repetitions, both direct eager and gateway conditions, with fresh gpt-6-luna agents (medium reasoning) and up to four concurrent workers. Fixtures, task prompts, call budgets and scoring are unchanged apart from session paths. Do not discard wrong answers or errors. Compare with the historical pilot and the contemporaneous direct control; scheduling/model service conditions can change absolute timings.

Changes under test: discovery returns three schemas by default (compact summaries still opt-in); server-alias-only matches no longer dominate capability ranking; deprecated tools rank lower; tool guidance explicitly routes discovered tools through execute; generic text/JSON/array helpers reduce result-shape mistakes; WASM module initialization is reused with a fresh isolated runtime/context per execution. The generic bridge now writes requests atomically. Gateway source is frozen during the rerun. No benchmark-specific field names or answers are embedded in product code.

Primary metrics: agent elapsed time from initial list to finish, correctness, tool calls and errors. Secondary: payload bytes/token proxies. All original limitations still apply, particularly host truncation of large direct results, missing actual billed usage, small sample size, synthetic data, and absence of a native deferred-tool control. The benchmark does not test malicious code, live OAuth interoperability, policy enforcement, or sensitive production MCPs.

The process caches connections per task; the experiment still uses a fresh gateway per run. Warm multi-task sessions are not measured. Any historical-versus-current timing differences are descriptive, not a controlled causal estimate of the code changes.
