# Public retrieval benchmark: public-v9

## Result

On this public retrieval task, the production gateway retrieved relevant tools weakly compared with the fixed local BM25 baseline. This is a retrieval-only result: it does not measure tool execution, answer quality, or live vendor systems.

## Scores

The primary denominator is all **7,961 original queries**. Failed requests remain in the denominator with zero retrieval scores. Metrics are macro averages; nDCG uses the benchmark's linear gains.

| Condition | nDCG@10 | Hit@1 | Hit@5 | Hit@10 | Recall@10 | Completeness@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Gateway (primary) | 0.0638 | 0.0420 | 0.0967 | 0.1216 | 0.0908 | 0.0682 | 0.0631 |
| Fixed BM25 (primary) | 0.2962 | 0.2353 | 0.4184 | 0.4793 | 0.3738 | 0.2894 | 0.3142 |

Paired query bootstrap (1,000 resamples; seed 901), 95% percentile intervals for nDCG@10: gateway **[0.0592, 0.0681]**, BM25 **[0.2879, 0.3049]**, gateway minus BM25 **[-0.2408, -0.2253]**. This captures query-population resampling, not model sampling variance.

The accepted-input subset is secondary and diagnostic only (7,601 queries: no error in either condition). It must not be read as the primary result because it excludes rejected and failed inputs.

| Accepted-input diagnostic | nDCG@10 |
|---|---:|
| Gateway | 0.0668 |
| Fixed BM25 | 0.2973 |

## Breakdown by query category

Values below are nDCG@10, with query counts. The category results are descriptive; small groups can be noisy.

| Category | Queries | Gateway | BM25 |
|---|---:|---:|---:|
| code | 1,749 | 0.0677 | 0.2477 |
| customized | 982 | 0.0146 | 0.2016 |
| web | 5,230 | 0.0718 | 0.3302 |

Source-level nDCG@10 results are included in the root manifest's category/source summaries to avoid reproducing a very wide table here.

## Dataset and protocol

The run used the complete ToolRet-full corpus: **44,453 tools, 7,961 queries, 14,106 relevance labels, 35 sources, and all three tool categories**. Queries were sent unchanged, without generated instructions, label hints, rewrites, or truncation. Tool descriptions were the complete published documentation. Names preserved the original capability name in sanitized form with an opaque stable hash; source IDs map rankings to relevance labels. This preserves documentation and mapping fidelity while avoiding vendor-specific exact configuration claims. Query and document texts are not distributed in this report.

The gateway rejects inputs over its 500 UTF-16-code-unit limit. **360** queries exceeded it and remain zero-scored in the primary denominator. Audited errors: gateway 360; BM25 0.

The comparison is retrieval only. BM25 uses the frozen local implementation (k1=1.2, b=0.75; lowercase alphanumeric tokens; name plus documentation; deterministic name/ID tie-break). It is not the production gateway's internal BM25 configuration or a vendor's BM25 implementation. All rankings were checked with ToolRet's `pytrec_eval` API; maximum metric discrepancies and backend scores are in `audit.json`.

## Runtime and execution history

The first **1,000 source-order queries** ran sequentially. Their measured p50/p95 times were gateway SDK round-trip **456.6/786.7 ms** and BM25 rank-only **56.4/86.8 ms**. This prefix is not an answer-latency measurement and is not a representative latency sample for the full benchmark. SDK in-memory RPC excludes process I/O, network, upstream startup, and model inference; BM25 timings cover ranking only. The prefix data is retained as `sequential-prefix.json` inside the audit bundle.

Execution began with eight full-corpus workers; memory pressure caused three shards (1, 4, 5) to be killed. The retry pass targeted only failed shards, with up to three workers, while preserving successful shard outputs and verifying prefix and success hashes. An interrupted first recovery was restarted. These infrastructure events did not change the frozen query set or scoring protocol. Contended worker timings are not used as answer latency.

## What this does not establish

This run used no LLM, provider tokens, billing data, response-quality grading, or live vendor retrieval results. StackOne's public ToolRet figures are related published context, not measurements reproduced in our environment; differences in query mode, names, documentation, tie-breaking, and undisclosed vendor settings prevent exact-score claims. MCP-Atlas was not executed because Docker and a native model/judge endpoint were unavailable. Historical small pilots remain smoke/regression tests and are not competitive benchmark evidence.

## Reproduction and artifacts

Reproduce the frozen Tier 1 run with the instructions in [`COMPARABILITY_PLAN.md`](../../COMPARABILITY_PLAN.md). In brief: install `benchmark/public-requirements.txt`, run `public-prepare.py` (then `--offline` after download), run `public-retrieval.mjs`, independently audit with `public-audit.py`, then run this report generator. The public dataset is downloaded locally and is not redistributed here.

Primary sources: [ToolRet evaluation code](https://github.com/mangopy/tool-retrieval-benchmark/blob/c4181d914a227134705ecb6bab13fbd92ccd2938/toolret/eval.py) and [StackOne Tool Discovery / ToolRet-full context](https://www.stackone.com/platform/tools-discovery/). See the [comparability plan](../../COMPARABILITY_PLAN.md), [protocol](protocol.json), [execution deviation record](execution-deviation.json), [manifest](manifest.json), [independent audit](audit.json), [gateway rankings](gateway.jsonl.gz), [BM25 rankings](bm25.jsonl.gz), [audit bundle (including sequential-prefix.json)](audit-bundle.tar.gz), and [retained infrastructure attempt archive](infrastructure-attempt.json.gz).

The raw ranking files and `audit-bundle.tar.gz` are preserved with the run artifacts. Do not distribute query or document text from the source dataset.
