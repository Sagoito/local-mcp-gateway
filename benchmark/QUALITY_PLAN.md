# Fresh factual-answer quality pilot

Prespecified on 2026-10-09 before task dispatch. Primary question: does the gateway preserve factual answer correctness, required details and evidence references on tasks that were not used to tune the implementation?

## Design

Eight new task types, two repetitions per condition, direct official MCPs versus the unchanged five-native-tool gateway: 32 fresh gpt-6-luna agents with medium reasoning. Alternate condition order and run at most four workers concurrently. Both arms use the same generic bridge, permissions, output budgets, twelve-call cap and isolated synthetic data. No product changes or native-profile tuning during this pilot. Expected answers remain outside agent prompts. Freeze source, fixture and compiled hashes before dispatch.

Use the installed official filesystem and memory MCP implementations. This is a two-server quality pilot, not validation across many distinct vendors, native client tool injection or client-side deferred schemas. Initial direct definitions and source responses must fit the host's display path. Preflight the real SDK responses and ask each worker to report any visible clipping separately from its submitted answer. A clipped run remains in the audit but is unsuitable for a fair complete-evidence comparison. Never replace completed wrong answers with successful retries.

## New tasks

1. Retrieve byte size and file type with the unfamiliar filesystem metadata tool, including multibyte UTF-8 content.
2. Retrieve two similarly named exact memory nodes with the unfamiliar open_nodes tool and keep their owners distinct.
3. Report that an owner is unknown when the graph supplies no owner, without inventing one.
4. Apply date, severity and state filters to a small incident set; return both count and matching IDs.
5. Follow an authoritative manifest to the active runbook, avoiding draft/archive distractors; preserve two actions and a rollback condition.
6. Resolve conflicting configuration values using an explicit revision policy.
7. Treat instructions embedded in source data as untrusted content and return the requested factual fields.
8. Recover from a genuine missing-file MCP error using a documented fallback, without masking that fallback was used.

Fixture files and graph data are deliberately small. Discovery tasks include tools outside the five native selections. Native selections are identical to query-v6 and are not changed per question. Models must retrieve and reason through the exposed MCP tools; shell/host code cannot read or process fixture data.

## Scoring

Primary: exact factual-answer accuracy per task and condition. Also report required-field accuracy/completeness, evidence-reference set precision/recall, malformed/extra answers, correct handling of missing information, and MCP call errors. Reference correctness does not alone establish that every claim is grounded in a read: trace review must separately check retrieval. Deterministic checks compare factual fields with generated ground truth; these structured tasks do not measure prose style or narrative summary quality.

Report every completed attempt and any interrupted/incomplete attempt. Two repetitions per task provide a diagnostic pilot, not a statistical noninferiority or superiority result. Do not generalize a perfect pilot score to production safety, prompt-injection resistance or all MCPs.

Secondary: elapsed time, tool calls and serialized definition/request/response token proxies. These are not provider-reported context, hidden reasoning or billed costs. Error recovery can involve an expected MCP error; report that separately from an unrecovered incorrect answer. Compare quality on complete-evidence runs and show exclusions explicitly rather than silently dropping failures.

## Completion

Publish immutable manifests, new questions and fixtures generation, all raw traces/answers, deterministic scoring and the observed limitations. Keep the gateway build unchanged, verify the recorded hashes, and push the results to the existing repository.
