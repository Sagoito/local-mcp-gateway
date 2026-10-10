# Local search and gateway improvement plan

Research and diagnostic completed 2026-10-10. This document proposes work; the production gateway and frozen public-v9 rankings remain unchanged.

## Decision

Keep TypeScript/Node and the small `search`/`execute` interface. Replace per-query substring scanning with a versioned, local BM25 index. Fix catalogue refresh and request scheduling next. Evaluate an optional small local embedding model only after the lexical path meets its quality and latency gates. An LLM call for every search would add another inference round trip, conflicting with the latency objective.

The measured baseline already demonstrates that a conventional local retriever can do much better than the current scorer. It does not demonstrate that a language rewrite, vector database, larger model, or new sandbox is needed.

## Evidence and current limitations

The full public ToolRet run has 44,453 tools and 7,961 queries. Its independently audited nDCG@10 is **0.063799 gateway versus 0.296189 fixed BM25**; Hit@10 is **0.121593 versus 0.479337**. All 360 gateway errors come from its 500 UTF-16-code-unit query limit. On the same accepted 7,601 queries, nDCG@10 remains **0.066821 versus 0.297273**. Raising the limit alone will not close the gap. The longest original query is 4,354 code units; an 8,192 limit accommodates the full current suite without truncation.

The original first-1,000-query sequential prefix measured gateway SDK p50/p95 **456.6/786.7 ms**, versus BM25 ranking-only **56.4/86.8 ms**. These cover different work and are not model-answer latency.

A new diagnostic selects five accepted queries spread across each of three categories, runs each twice with reversed direct/SDK order, and verifies identical results. Median direct `searchCatalog` is **655.5 ms**, versus SDK round-trip **623.5 ms**; means are **786.6/780.9 ms**. The small sample and timing noise do not justify subtracting these values to estimate RPC overhead. They do show that direct ranking itself is expensive. Median candidate count is **44,453**, and the top ten have a median of only **three distinct scores**. Selection uses no relevance labels. Raw measurements are in `benchmark/results/public-v9/search-diagnostic.json`; the reusable runner is `benchmark/search-diagnostic.mjs`.

Code inspection identifies these mechanisms:

| Location | Current mechanism | Consequence |
|---|---|---|
| `src/server.ts:searchCatalog` | Rebuilds server terms, normalizes names, lowercases full descriptions, scans each term, then sorts all matches | Repeated work proportional to catalogue size and documentation bytes |
| Same scorer | Boolean substring scores, fixed name boost, no document-frequency weighting | Common words can match almost everything; a short term can match inside another word; many ties fall back to alphabetical order |
| Same scorer | Removes query tokens matching any server alias and penalizes any documentation containing “deprecated” | Potentially useful connector terms disappear; incidental text can cause demotion |
| `src/server.ts:run` | One promise queue for search, direct calls, retained queries, and code | A slow request blocks independent operations; this is code evidence, not yet a measured contribution to agent latency |
| `src/server.ts:serve` | Reads/parses configuration before every call | Avoidable warm-call IO; reload currently closes all upstreams |
| `src/upstreams.ts:listTools` | Reaggregates/sorts tools every request; 30-second expiry can trigger blocking rediscovery | Freshness work lies on the request path; unavailable upstreams can amplify tails |

Public-v9 supplies a cached synthetic catalogue and bypasses production upstream discovery. Production discovery currently limits newly discovered tools to 5,000. The 44,453-tool fixture therefore does not establish live discovery capacity or measure OAuth, expiry, config IO, startup, or real stdio overhead. These need separate operational tests.

## Research findings

* **Local lexical search is an established implementation path.** SQLite FTS5 provides BM25, column weighting, and a rank-sorted limited-query path. MiniSearch provides an offline in-memory JavaScript index, field boosting, and incremental add/remove. Their rankings/tokenization are not automatically identical to our frozen reference. [1,2]
* **Semantic matching can help after lexical retrieval.** StackOne reports gains from tool-specific training, hard negatives, consistent formatting, and connector-level holdouts. Its published scores and deployment times are vendor reports, not predictions for our laptop. Do not assume its fine-tuned model is available or that our model will reproduce its result. [3]
* **A small model can run locally.** BGE-small-en-v1.5 has 384-dimensional outputs, a 512-token sequence limit, ONNX artifacts, and an MIT license. MiniLM-L6-v2 is a comparison candidate; its model card warns that inputs over 256 word pieces are truncated by default. Long documentation requires explicit formatting/chunking choices. Node ONNX bindings and Transformers.js local-model settings permit a local runtime. [4–7]
* **Combine lexical and dense ranks explicitly.** Reciprocal Rank Fusion combines ranks without calibrating unlike score scales. Its original constant is 60. This is a reasonable fixed experimental starting point, not proof of improvement on tools. [8]
* **Refresh can follow the protocol.** MCP supports paginated lists and `notifications/tools/list_changed`. Subscribe where supported, with a bounded background polling fallback for servers without notifications. [9]
* **Code Mode solves a different part of the workflow.** Cloudflare composes calls and processes results in isolated runtimes. That can reduce agent turns/output, but it does not repair our substring ranking. Our direct-call and data-query paths already avoid code for common requests; keep those paths. [10]

## Implementation sequence

### 1. Indexed BM25 and a versioned catalogue

Add a `SearchIndex` owned by an immutable catalogue generation, not by each `search` invocation. Build once after discovery and rebuild only when tool names, descriptions, schemas, enabled servers, or access scope change. Explicit server/tool lookup uses a map. Preserve original execution names and schemas; search normalization must never rename an upstream invocation.

Start with the exact frozen reference formula: k1=1.2, b=0.75, log(1+(N-df+0.5)/(df+0.5)), name plus full description, existing ASCII tokenization. This isolates the algorithm change. Store postings, document lengths and inverse document frequencies once. Use numeric document IDs, reusable score storage, and a bounded top-k heap rather than sorting every candidate. Precompute deterministic tie order. Keep double precision initially and verify optimized rankings against the simple reference. Do not return arbitrary zero-score matches as useful discoveries.

Recommendation: implement this bounded index in TypeScript, using the existing tested reference as the specification. Compare memory/build/query performance before choosing a dependency. MiniSearch is an alternative if it materially simplifies maintenance; SQLite FTS5 is the fallback if a large in-memory index exceeds the memory budget. Either substitution is a distinct ranking experiment and requires its own audit. No database service is required.

Raise the validated query limit to 8,192 code units in both Zod and the exposed JSON Schema. Preserve a request byte cap, cancellation, and a bounded processing budget; return explicit errors when exceeded. Never silently truncate queries or benchmark inputs. Keep the 24 KiB discovery response ceiling and fixed small tool-definition budgets.

Suggested files: new `src/search.ts`, integration in `src/server.ts`, catalogue generations in `src/upstreams.ts`, `test/search.test.ts`, and a separate `public-v10` run. No edits to public-v9 inputs/rankings.

### 2. Refresh and scheduling

Keep a catalogue snapshot on the warm request path. Rediscover asynchronously on notifications/expiry, deduplicate refreshes, validate a replacement, then atomically install a new generation/index. Failed refreshes mark availability explicitly. Removed/disabled servers or revoked credentials disappear immediately from searchable and executable state; stale snapshots cannot preserve authorization. Preserve valid connections to unchanged upstreams.

Serialize configuration/generation transitions rather than all requests. Use request leases so an upstream cannot close beneath an authorized in-flight call. Run independent searches and permitted calls with bounded concurrency; preserve required write ordering and retained-result isolation. Put expensive indexing in a persistent worker if it would block the event loop. Avoid a worker/process per query; Node documentation recommends a pool for CPU tasks because creation overhead can exceed the benefit. [11]

Watch config changes with a stat/poll fallback and atomic config replacement. Test missed events and reload races. Add cancellation while queued, per-server timeouts/backoff, and refresh-time telemetry. A small optional LRU must include catalogue generation, access scope, exact normalized query, filters and ranker configuration. Test cold cache misses; cache hits cannot conceal a slow retriever. Do not cache side-effecting executions.

### 3. Better metadata and optional local hybrid retrieval

Evaluate identifier splitting, Unicode tokenization, explicit connector/name fields, constrained field boosts, and query-matching snippets as separate ablations. Preserve authoritative descriptions/schemas; generated summaries are supplementary. Keep named connector words as retrieval evidence rather than automatically removing them. Hard narrowing requires an explicit server filter. Distinguish read/list/search from create/update/delete. Do not infer access permission or deprecation from arbitrary tool descriptions.

Benchmark one pinned quantized BGE-small artifact against a pinned MiniLM artifact on the target CPU. Install/cache weights explicitly, verify checksums and licenses, disable remote loading at runtime, and use lexical search when the optional model is unavailable. No external embedding calls or sign-in. Quantization and ONNX conversion require their own equivalence/quality checks.

Precompute tool vectors at catalogue update; infer only the query vector per request. For BGE-small, one float32 vector per 44,453 tools requires about **65.1 MiB** before model, index, and runtime overhead. Multiple chunks multiply this amount. Compare a bounded exact vector scan with an approximate index before adding ANN dependencies. Retrieve independent lexical and dense candidate lists and fuse with fixed RRF; do not dense-rerank only lexical candidates, because that cannot recover tools lexical retrieval missed.

Keep full-text lexical coverage of long documentation. Specify any semantic chunking, pooling, and maximum chunks per tool; disclose semantic truncation. A fixed model prefix is recorded as model preprocessing, distinct from ToolRet's optional generated instruction field. Evaluate plain-query and documented-prefix conditions separately when needed.

Cross-encoder reranking of a small candidate set and domain-specific fine-tuning are later experiments only if they improve held-out quality within the CPU budget. Do not add an LLM planner, automatic synonym generator, or heavy reranker to every query by default.

### 4. Fewer agent turns and safe execution

Keep existing deterministic direct-call and retained-result filtering paths. Evaluate compact ranked summaries versus a small number of full schemas using native agent loops; reducing one payload may add another model turn. Preserve the stable five-tool native profile for a separate fixed-profile track; do not tune it per test question or silently expose growing tool lists.

Offer a configuration mode that disables `execute.code` while retaining typed calls/data filtering. If code is enabled, preserve fresh QuickJS state, memory/time/call/output caps and capability-scoped calls. Never replace the sandbox with host `eval`/`new Function`, unrestricted imports, or a shared guest context as a latency shortcut. The currently reused WASM module already avoids repeated module initialization. Tool permissions must apply to both direct and guest calls; sandbox isolation alone does not authorize upstream side effects.

## Success gates: targets, not measured promises

Pin hardware, Node version, corpus, scripts and query order. Warm latency means a ready catalogue/index and model, but an empty query-result cache. Report build/startup/refresh separately.

| Gate | Initial acceptance target |
|---|---|
| Stage 1 retrieval | Full-suite gateway nDCG@10 at least 0.29, approaching the measured 0.2962 BM25 reference; no unexplained precision/recall losses |
| Query acceptance | All 7,961 original public queries accepted within the new cap; zero infrastructure/tool-search errors |
| Lexical warm SDK, up to 5,000 tools | p50 ≤20 ms, p95 ≤50 ms on the designated CPU |
| Lexical warm SDK, 44,453-tool fixture | p50 ≤50 ms, p95 ≤100 ms; report genuine worst cases and term/posting counts |
| Catalogue lifecycle | Add/remove/revoke reflected correctly; warm execution not blocked by unrelated discovery; no stale-permission calls |
| Memory | Initial lexical goal ≤512 MiB RSS at 44,453 tools; separately measure peak rebuild and optional model memory |
| Optional hybrid | Meaningful paired quality gain over the indexed lexical release, with p95 ≤100 ms at 5,000 tools and ≤150 ms at 44,453; otherwise remains optional |
| Context | Default still two tools; native profile still bounded to five additional tools and its existing definition budget; report schema/result tokens and actual usage separately |
| Small-result execution | Proposed warm gateway-added p50 ≤5 ms and p95 ≤15 ms versus the same direct upstream; verify over real stdio, not just in-memory transport |

These targets are engineering goals. The existing 56 ms BM25 median has not demonstrated the tighter goals; postings/top-k optimization must be measured. Hybrid inference, runtime memory and speed on Windows/macOS/Linux remain unknown. A faster discovery call cannot guarantee a faster final answer.

## Validation and release policy

1. Preserve the audited baseline and its complete infrastructure history. Run each candidate in a new directory. Record product, adapter, model, dataset and metric hashes. Audit all rankings with the independent official backend.
2. Run reference-equivalence tests for optimized BM25 and top-k, including ties, empty/no-match queries, filters, Unicode, repeated terms, long queries and catalogue replacement. Add lifecycle tests for paginated discovery, notification bursts, expired caches, removed servers, cancelled queues and failed refreshes.
3. For latency, use a prespecified randomized, category/source-stratified query sample with repeated matched runs. Include long/common-term queries, cache misses, 1/4/8 concurrent clients, startup, expiry and refresh storms. Run one full-corpus evaluator at a time within 8 GiB; the previous eight-worker OOM must not recur. Measure current 2/8/16/32-process configurations separately from distinct-implementation coverage.
4. Treat ToolRet as a public development benchmark once repeatedly used for optimization. Do not claim a fresh unseen test after tuning on it. Select field weights/models using separate development data, then freeze and evaluate previously unused ToolBench/MetaTool and connector-held-out operational tasks. No benchmark qrels or prompts in synthetic training, synonyms, summaries or native selections. Record known training/evaluation overlap and all tried configurations.
5. Native MCP-Atlas/end-to-end evaluation still needs a usable sandbox and native model/judge endpoint. Compare direct tools, client deferred tools where supported, lexical gateway and optional hybrid using the same model, budgets, permissions, tasks and original tool whitelists. At least three repetitions; retain wrong answers. Prespecify a five-percentage-point noninferiority margin for completion and inspect its paired interval. Measure gateway/direct warm answer latency ratio, actual input/output/cached usage and separately priced judge cost. A target ratio ≤1.10 is conditional on meeting quality; it is not a current result.
6. Promote a candidate only after accuracy, latency, memory, context and lifecycle checks all pass. A failed stage stays an experiment, and its negative result is retained. Start with stage 1; do not couple it to embeddings, fine-tuning, OAuth redesign or a language rewrite.

## Primary sources

1. [SQLite FTS5: BM25 and rank-sorted limited queries](https://sqlite.org/fts5.html)
2. [MiniSearch official repository](https://github.com/lucaong/minisearch)
3. [StackOne: tool retrieval training and evaluation](https://www.stackone.com/blog/autoresearch-charged-action-search/)
4. [BAAI BGE-small-en-v1.5 model card](https://huggingface.co/BAAI/bge-small-en-v1.5)
5. [Sentence Transformers MiniLM-L6-v2 model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
6. [ONNX Runtime Node binding](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
7. [Transformers.js local-model configuration](https://huggingface.co/docs/transformers.js/api/env)
8. [Cormack, Clarke and Buettcher: Reciprocal Rank Fusion, SIGIR 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)
9. [MCP tool lists, pagination and list-change notifications](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
10. [Cloudflare Code Mode and isolated execution](https://blog.cloudflare.com/code-mode/)
11. [Node worker pools and CPU task overhead](https://nodejs.org/api/worker_threads.html)
