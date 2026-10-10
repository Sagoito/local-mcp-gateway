# Public benchmark protocol and comparison limits

The earlier six/eight-question suites are local regression and smoke tests. They do not support a competitive quality claim. Several prompts name the required tool, only two implementations supply the tools, the five-tool native profile favors common operations, and the agent receives definitions through a shell bridge rather than native provider tool registration. The quality-v8 pilot also exposed two grading ambiguities. Keep its frozen scores, questions and failed answers; do not retroactively replace them with better results.

## What comparable evaluations use

| Primary source                                                                                                         | Published evaluation                                                                        | What we can reproduce                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [StackOne tool discovery](https://www.stackone.com/platform/tools-discovery/)                                          | MetaTool, ToolBench and ToolRet-full; retrieval ranking metrics                             | ToolRet-full's public corpus, queries, relevance labels and nDCG@10                               |
| [Stacklok comparison framework](https://github.com/StacklokLabs/mcp-optimizer/tree/main/examples/anthropic_comparison) | Shared catalog and test cases; model-directed discovery versus Anthropic native tool search | Public framework/data; its native provider comparison requires credentials                        |
| [Stainless MCP eval harness](https://github.com/stainless-api/mcp-evals-harness)                                       | Domain task suites, native provider loops, factuality/completeness and efficiency           | Published runner/suites; live API accounts and model access are required                          |
| [MCP-Atlas](https://github.com/scaleapi/mcp-atlas)                                                                     | Public tasks on pinned MCP servers, native model tool calls, claim coverage                 | Official public task set and Docker harness; server/API/model availability determines eligibility |

These evaluate different layers. Tool retrieval finds candidate tools; task completion also requires choosing valid arguments, executing tools, interpreting results and answering correctly. A retrieval score is not an answer-quality score. A published vendor figure is not a measurement of that vendor in our environment. StackOne's tables explicitly use different sample counts for some provider comparisons. Do not combine them into a leaderboard of our own results.

## Tier 1: public retrieval, executed in public-v9

Use the entire **ToolRet-full** evaluation set: **44,453 tools, 7,961 queries, all 35 sources and all three tool categories**. Download only the evaluation repositories, not training data. Pin both Hugging Face revisions and SHA-256 hashes of all 38 Parquet files. The lock and downloader make subsequent evaluation fully offline.

The runner uses the existing production gateway through an MCP SDK Client/Server pair with InMemoryTransport. Catalog entries are hydrated from the published documentation. Tool calls are disabled; only discovery is exercised. There are no live API implementations behind these corpus entries. The public interface advertises `search` and `execute`, with no selected native tools or inline catalog. The upstream catalog is complete and cached in memory.

Descriptions contain the **full, verbatim published documentation**. Original capability names are sanitized and suffixed with a stable opaque hash to disambiguate duplicates; two nameless documents receive an `unnamed` prefix. Source IDs map the returned names back to the original relevance labels. Do not use source/category aliases as tool names, expected answers as discovery hints, server filters, or per-task whitelists. Placeholder empty object schemas are explicitly retrieval fixtures, not executable tool contracts.

Send each original user query unchanged to `search`, with `includeSchema:false` and `limit:10`. Do not supply the generated `instruction` field, rewrite queries, drop failures, truncate long queries, or tune the product against evaluation labels. All 7,961 queries remain in the primary denominator. Queries rejected by the product's 500-character limit count as zero retrieval scores; record the exact errors. A successful-input subset is diagnostic only.

Compare with a local, fixed BM25 baseline using the same capability-name-plus-documentation text, lowercase alphanumeric tokens, k1=1.2, b=0.75 and log(1+(N-df+0.5)/(df+0.5)). No stemming, stop-word filtering, expansion, embeddings, parameter search or training. Build the index once; validate its ranks against a simple reference implementation. Ties are resolved by name then source ID. This baseline is not Anthropic's server-side BM25 implementation or the authors' BM25s configuration.

Primary: macro **nDCG@10**, using the authors' linear-gain definition. Also record Hit@1/5/10, Recall@5/10, Precision@5/10, all-target Completeness@5/10 and MRR@10. Every current public relevance label is 1; the evaluator supports graded labels and has independent graded test cases. Completeness is binary (all required tools retrieved), not fractional recall. Audit every ranking with the `pytrec_eval` API used by the published evaluator. Report paired query-bootstrap confidence intervals, plus per-source/category results.

Record per-query source IDs, query SHA-256, qrels, ranks, errors and runtime; freeze hashes of the corpus, runner, configuration and compiled gateway. Check that the build did not change. Preserve all failures. Ten fixed warmup queries precede each runner pass. Independent remaining queries may run in full-corpus workers to reduce total benchmark wall time; the first sequential checkpoint is retained, and contended worker timings are kept separate. The first eight-worker attempt exceeded this workspace's 8 GB RAM limit. Its three killed shards are archived and retried at concurrency three; successful outcomes are never replaced. Report p50/p95 gateway SDK round-trip and BM25 rank-only time from the sequential prefix separately; its first 1,000 queries are a source-order subset, not a representative full-suite latency sample. In-memory RPC excludes process IO, network, upstream startup and model inference; these timings are not a user-answer latency comparison.

ToolRet's corpus and nDCG@10 metric match the public benchmark family used by StackOne. Query mode, documentation formatting, name normalization, tie-breaking and model-specific instructions can change results. Vendor indexing/model settings are not all specified publicly. Therefore this is a reproducible shared-dataset comparison, **not an exact reproduction of a vendor score or a live head-to-head test**.

## Tier 2: public end-to-end answer quality, not yet executed

Use **MCP-Atlas's 500 public tasks**, unchanged prompts, ground-truth claims, pinned server image and official claim-coverage scorer. Retain task IDs and dataset/build hashes. Eligibility follows the original enabled tools and available server credentials; missing services are recorded, never silently counted as successful tests. A no-key or sampled subset must be labeled as that subset, not the full public leaderboard score. Record the exact official repository revision and dataset revision when this tier starts, because the public harness is evolving.

Run matched task pairs with the same provider/model/version, reasoning settings, token/tool-call limits, tool-result cap, judge and server data. Reset each mutable sandbox before each task. Preserve original task tool whitelists in the comparable official track; a separate all-catalog distractor stress track must be labeled as a protocol extension. Do not let an oracle whitelist into one condition but not the other.

Compare eager native MCP tools, the client's native deferred tools when available, this gateway's default discovery, and a globally fixed native profile. Add actual competing gateways only when they can run against the same catalog and permissions. Register schemas as real provider tools: the historical Luna shell bridge is unsuitable for this tier. Use a supported provider endpoint or a local compatible model endpoint; do not infer native quality, hidden reasoning tokens or billed cost from orchestration-agent traces.

Use the official claim-level scorer and report pass rates at its 0.50 and 0.75 claim-coverage thresholds, coverage distributions, completed/incomplete tasks, tool errors and failure reasons. Blind judge input to condition labels. Keep all wrong answers; retry only recorded infrastructure failures under a fixed policy, retaining the originals. Alternative valid tool paths should receive credit. For stochastic model comparisons, use at least three repetitions per task and paired analysis; freeze the task/sampling manifest and scoring rubric before dispatch.

Measure total response time, time to first tool, p50/p95, model calls, discovery calls and upstream execution separately. Record provider-reported input/output/cached tokens and usage for every call. Calculate costs from recorded usage and explicitly versioned provider prices; keep judge cost separate. Mark unsupported usage fields unavailable. Equal budgets, warm/cold modes and model settings are required before attributing differences to the gateway. If a provider cannot register the full catalog because of its tool or context limits, record that configuration limit explicitly; do not silently truncate definitions and call it a quality failure.

**Current execution gap:** this workspace has no Docker installation for the Atlas sandbox, and a native model/judge evaluation endpoint has not been supplied for this harness. Public-v9 therefore makes no new answer-quality, native model token-usage or billed-cost claim. The gateway remains local; evaluation may use a local model endpoint or a paid provider, chosen explicitly for the paired run. The old smoke tests do not fill this gap.

## Tier 3: local operational regression

Keep the existing filesystem/memory pilots and unit checks for metadata, unfamiliar tool discovery, missing information, conflict resolution, joins, fallback errors and untrusted source data. Separately test add/remove/reload, startup versus warm calls, remote MCP OAuth refresh/cancellation, oversized results and code-execution limits. These establish local behavior, not competitor benchmark placement. OAuth requires real provider/client support and cannot be established by public retrieval fixtures.

## Reproduce Tier 1

Install the runtime and prepare the normalized dataset once:

```bash
npm ci
python -m venv .local/public-venv
.local/public-venv/bin/pip install -r benchmark/public-requirements.txt
.local/public-venv/bin/python benchmark/public-prepare.py
node --test benchmark/public-retrieval.test.mjs
```

The historical public-v9 gateway score is reproducible only with the frozen v9 runner and compiled gateway in its audit bundle. Do not run the current root `benchmark/public-retrieval.mjs` after `npm run build` and label that result v9: the runner imports `../dist/server.js`, which would then be the current product. Use an isolated work directory so the current checkout's `dist` remains untouched:

```bash
mkdir -p .local/public-v9-repro
tar -xzf benchmark/results/public-v9/audit-bundle.tar.gz -C .local/public-v9-repro benchmark/public-retrieval.mjs dist
ln -s "$PWD/node_modules" .local/public-v9-repro/node_modules
node .local/public-v9-repro/benchmark/public-retrieval.mjs "$PWD/.local/public-data/toolret-full.json" "$PWD/.local/public-v9-repro/run"
.local/public-venv/bin/python benchmark/public-audit.py .local/public-data/toolret-full.json .local/public-v9-repro/run
```

The v9 runner retains the old 500-character limit and therefore reproduces its 360 historical over-limit query errors. The current indexed v10 product uses `benchmark/indexed-retrieval.mjs` instead, with the frozen v9 BM25 rankings as its reference; it accepts the full 8,192-character query limit. See [public-v10 report](results/public-v10/README.md) for its run and paired local latency/memory diagnostics.

```bash
npm run build
node benchmark/indexed-retrieval.mjs .local/public-data/toolret-full.json benchmark/results/public-v9 .local/public-new-run
.local/public-venv/bin/python benchmark/public-audit.py .local/public-data/toolret-full.json .local/public-new-run
```

After the first download, use `public-prepare.py --offline`. The sequential runner is the default for machines with 8 GB RAM. `public-parallel.mjs` uses eight workers and can exceed 8 GB; if that attempt records infrastructure failures, `public-retry.mjs <dataset> <output-dir>` retries only the failed shards with up to three workers and retains the initial failure archive. Output raw rankings and manifests belong to a fresh run directory; never overwrite a published baseline with tuned results. Checkpoint resumes require identical dataset, runner, configuration and build hashes. Source data is downloaded locally instead of being redistributed in this MIT repository; upstream datasets combine separately maintained sources. Cite [Shi et al., ACL 2025](https://arxiv.org/abs/2503.01763), and preserve upstream licensing when separately redistributing any dataset.
