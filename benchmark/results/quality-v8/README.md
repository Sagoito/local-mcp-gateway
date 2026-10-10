# Historical local smoke/regression pilot

This eight-task pilot is retained for regression diagnosis. It is not a competitor-comparable benchmark; some prompts identify tools, the catalog has only two server implementations, and the model receives definitions through a shell bridge. Its frozen scores and raw outcomes remain unchanged. See [the public comparison protocol](../../COMPARABILITY_PLAN.md) and [public-v9](../public-v9/README.md) for the replacement main evaluation.

## Fresh factual-answer quality pilot

32 fresh Luna attempts compared direct MCPs with the unchanged gateway on eight new task types. The frozen grader scored **14/16 exact factual answers direct versus 13/16 gateway**. The gateway had one additional extraction mismatch. This small pilot does **not** establish quality equivalence, superiority or a statistically reliable regression.

Every worker reported complete advertised definitions and no visible clipping. The fixtures are deliberately small, so this comparison avoids the clipped-response problem in earlier pilots. All completed outcomes, including mismatches, are retained without retries.

## Frozen results

| Metric | Direct MCPs | Gateway |
|---|---:|---:|
| Completed attempts | 16/16 | 16/16 |
| Exact factual answer matching gold | 14/16 | 13/16 |
| Required fields matching gold | 32/34 | 31/34 |
| Required fields present and correctly typed | 34/34 | 34/34 |
| Exact facts plus reference set | 12/16 | 12/16 |
| Reference precision, pooled | 24/24 | 24/24 |
| Reference recall against gold, pooled | 24/26 | 24/26 |
| Verified error-before-fallback recovery | 2/2 | 2/2 |
| Required nonnative tools actually invoked | 4/4 | 4/4 |
| Unexpected top-level fields | 0 | 0 |
| Visible clipping reported | 0 | 0 |

“Exact factual answer” excludes evidenceRefs but includes every other required field, including evidenceSource. It is strict canonical JSON equality, not a human judgment that a differently worded answer is false. Reference sets ignore ordering. Precision checks reference correctness; it does not establish complete claim grounding.

## What differed and where grading was underspecified

All six task types covering metadata, exact-node retrieval, missing owners, filtering, active-runbook selection and untrusted source text returned the expected facts in both repetitions: **12/12 direct and 12/12 gateway**.

For the conflicting-revision task (q6), all four attempts returned the correct revision 8, threshold 0.82 and all three evidence references. The gold evidenceSource was `config/model-v8.json`, but the prompt specified only a string field, without explicitly requiring that exact file path. Answers used the policy path or an explanatory sentence. The frozen grader marks all four as mismatches; those are not reliable evidence of wrong operational facts.

For fallback recovery (q8), all four traces show a genuine missing-preferred.txt MCP error followed by a successful fallback.txt read. One gateway attempt returned `fallback value: amber-17` rather than the gold identifier `amber-17`; the other three extracted the identifier. This is an observed extraction/output mismatch with complete source delivery, rather than evidence of a missing upstream result. All four answers cited fallback.txt but omitted the failed path. The gold reference set expected both paths, although the prompt did not explicitly require citing the failed read. The frozen recall score therefore remains 50% for this task while the recovery trace independently passes.

These benchmark ambiguities are recorded in [analysis-notes.json](analysis-notes.json). The gold answers, prompts and primary grader were frozen before dispatch and were not changed after seeing results. No wrong completed answer was repeated. A separately labeled **post-hoc sensitivity** removes only the ambiguous q6 evidenceSource field: 32/32 remaining required fields match direct versus 31/32 gateway. This must not replace the frozen primary score or be presented as a prespecified result.

## Retrieval and evidence

Trace review confirmed that every cited file was requested through a successful MCP read or metadata operation, and every cited memory node appeared in a successful graph-read response. This verifies retrieval opportunity, not internal reasoning or comprehensive grounding of every claim. [review.json](review.json) records each check and each worker delivery audit.

The two tools outside the unchanged five-tool native profile, get_file_info and open_nodes, were invoked successfully in all eight relevant attempts across the two arms. Gateway workers discovered them and used structured execute.call. No generated-code calls were observed in the pilot. The misleading-text task contains one simple instruction-like note and explicitly tells workers to treat it as data; passing it is not a security or prompt-injection-resistance claim.

## Secondary timing and payload measurements

| Metric | Direct MCPs | Gateway |
|---|---:|---:|
| Median elapsed | 6.78 s | 7.37 s |
| Mean elapsed | 7.57 s | 9.33 s |
| Maximum elapsed | 15.70 s | 31.37 s |
| MCP bridge calls | 30 | 34 |
| MCP error responses | 2 | 2 |
| Initial definition token proxy | 2,749 | 1,647 |
| Median accumulated payload token proxy | 3,580 | 2,341 |

The gateway median is 8.8% higher, and its mean is 23.3% higher; a runbook-search attempt took 31.37 s and included extra exploratory reads. The two error responses per arm are the expected missing-file recovery cases. These timings span first list request to finish request start, include cold setup and generic shell orchestration, and exclude worker scheduling and the initial prompt-file read. They are descriptive, with only two repetitions per task.

Definition payload is 40.1% smaller, and median accumulated serialized payload is 34.6% smaller. Token values use o200k_base and count payloads, not provider-reported context, hidden reasoning, usage or billed costs. Accumulated payload counts prompt, initial definitions, requests, responses and final answer once; it does not model replayed input or cache behavior. The experiment uses a generic bridge, not native tool-registry injection or a client that already defers schemas.

## Method, artifacts and reproduction

Eight new tasks × two repetitions × direct/gateway; gpt-6-luna, medium reasoning, at most four workers. Same real official filesystem/memory MCP versions, small synthetic fixtures, read-only task instructions, twelve-call cap and the same five native selections as query-v6. Product code and compiled hashes remained unchanged. This is two MCP implementations, not a many-vendor or OAuth quality test. Structured factual tasks do not measure prose quality, comprehensive reasoning, real operational judgment or production safety.

Preflight retrieved all fixture files together and the complete memory graph through the real SDK. The largest measured preflight payload was the direct catalogue at 2,749 token proxies; all fixture files together measured 1,652. The workers independently reported no clipping. The first gateway worker initially interpreted completeness as all upstream tools; a post-finish audit clarification confirmed all seven advertised public definitions were fully visible, without additional task calls or a rerun.

See [prespecified plan](../../QUALITY_PLAN.md), [questions and gold answers](questions.json), [manifest](manifest.json), [per-run CSV](runs.csv), [summary](summary.json), [generated scoring report](REPORT.md), [preflight](preflight.json), [grading self-checks](grading-selfcheck.json), and [raw audit archive](audit.json.gz). The archive retains fixture contents, all 32 configs/prompts/events/answers, memory snapshots and delivery observations. [preflight.json.gz](preflight.json.gz) retains the real SDK preflight responses.

```sh
npm ci
npm run build
node benchmark/quality-prepare.mjs /tmp/new-quality-runs --gateway-entry "$PWD/dist/cli.js"
node benchmark/quality-preflight.mjs /tmp/new-quality-runs /tmp/new-quality-report
node benchmark/daemon.mjs /tmp/new-quality-runs
```

Run the generated prompts once each with fresh Luna agents following order.json and the concurrency cap. Each worker may read only its assigned prompt as setup; afterward it follows the MCP-only restrictions. Store its final visibility audit separately, then run:

```sh
node benchmark/quality-analyze.mjs /tmp/new-quality-runs /tmp/new-quality-report
```

Scoring self-checks verify a correct answer passes, an incorrect value fails, reference order is ignored, and recovery order is checked. The product build and all 59 existing tests pass. The scripts generate deterministic frozen scores; review.json and the interpretation here additionally contain coordinator trace review and clearly labeled post-hoc interpretation.
