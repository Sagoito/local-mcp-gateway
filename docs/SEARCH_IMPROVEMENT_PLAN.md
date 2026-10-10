# Local search and gateway improvement plan

Research, stage 1 implementation, and the public-v10 retrieval audit completed 2026-10-10. Stage 1 is the first product improvement release. The benchmark is evidence about product retrieval, not an objective to tune rankings against.

## Decision

Keep TypeScript/Node and the small `search`/`execute` interface. Stage 1 replaces per-query substring scanning with a reusable local BM25 index and lifts the query limit to 8,192 code units. It includes server aliases because users may search by configured connector name. Refresh scheduling is the next product concern; embeddings remain a later optional experiment after operational behavior is measured.

The first release improves retrieval without a language rewrite, vector database, larger model, or new sandbox. The ToolRet public benchmark measures this product change; it is not used to introduce benchmark-specific aliases, synonyms, or tuning.

## Evidence and current limitations

The public-v10 run has 44,453 tools and 7,961 queries. Independent audit reports product nDCG@10 **0.295644** and frozen reference nDCG@10 **0.296189**, with zero errors in both. The product index indexes configured server alias, capability name, and full description; the frozen reference indexes only name and description. Server aliases remain in the product index for connector-name queries; the benchmark run did not isolate their exact effect from other ranking details. The 95% paired query-bootstrap interval for product minus reference is [-0.000887, -0.000234]. All 360 queries over the previous 500-character limit were accepted with the new 8,192-character limit. This is a retrieval benchmark and makes no answer-quality or cost claim.

Public-v10 local in-memory SDK latency after ten warmups (then measuring all 7,961 queries, including the ten again) is p50 **2.44 ms**, p95 **6.70 ms**, max **44.56 ms**; first cold search including index construction was **916 ms**. In a separate same-SDK paired sample of 90 seeded queries (30/category, <=500 UTF-16 units, two balanced-order repetitions; 180 paired observations / 360 individual SDK search calls), old gateway p50/p95 were **417.88/834.70 ms** and indexed gateway **2.59/4.92 ms**, with zero errors. Median paired old/new ratio was **177.94×**; ratio of p50s was 161.4×. The mean paired ratio was **191.02×** (query-bootstrap 95% interval **177.84×–205.06×**). This interval reflects query sampling only; the sample is not source-stratified and excludes model/provider, network, and upstream work. First cold search was slower with indexing (**883.6 ms** vs **693.5 ms**). Peak RSS was **631 MiB**, process-wide and including the gateway, index, SDK, and benchmark data. Separate fresh-process index-only measurements report 5,000-tool build **116.5 ms** and retained heap/RSS deltas **12.0/14.3 MiB**, and 44,453-tool build **939.1 ms** with **92.2/220.4 MiB** retained heap/RSS deltas. These direct index calls do not establish 5,000-tool SDK latency. Production discovery remains capped at 5,000 tools, so the 44,453-tool fixture does not establish live discovery capacity. The run passed 65 product tests and six metric checks. See [public-v10 report](../benchmark/results/public-v10/README.md).

The public-v9 prefix measurement is historical evidence only: it mixed gateway SDK round trips and BM25 ranking-only timings and is not comparable to the public-v10 post-index SDK latency.

A pre-index v9 diagnostic found expensive direct ranking and many score ties. It is retained as historical context, not as a performance comparison for v10. The v10 report records full-suite, paired old/new SDK, cold-index, and isolated index-memory measurements.

Code inspection identifies these mechanisms:

| Location | Current mechanism | Consequence |
|---|---|---|
| `src/server.ts:searchCatalog` | Reuses an indexed BM25 search object per immutable catalogue array | Search avoids rebuilding terms and scanning/sorting every catalogue entry on each request |
| `src/search.ts` | Lowercase `[a-z0-9]+` tokens; BM25 over configured server alias, capability name, and full description; deterministic tie order; bounded top-k | Connector aliases remain searchable; explicit server/tool fields perform exact filtering |
| `src/server.ts:run` | One promise queue for search, direct calls, retained queries, and code | A slow request blocks independent operations; this is code evidence, not yet a measured contribution to agent latency |
| `src/server.ts:serve` | Reads/parses configuration before every call | Avoidable warm-call IO; reload currently closes all upstreams |
| `src/upstreams.ts:listTools` | Reuses sorted aggregate array while per-server snapshot references and error state stay unchanged; refresh remains request-triggered after 30-second cache expiry | Repeated sorting is removed; cold/expired discovery can still block a request |

Public-v9 supplies a cached synthetic catalogue and bypasses production upstream discovery. Production discovery currently limits newly discovered tools to 5,000. The 44,453-tool fixture therefore does not establish live discovery capacity or measure OAuth, expiry, config IO, startup, or real stdio overhead. These need separate operational tests.

## Research findings

* **Local lexical search is an established implementation path.** SQLite FTS5 provides BM25, column weighting, and a rank-sorted limited-query path. MiniSearch provides an offline in-memory JavaScript index, field boosting, and incremental add/remove. Their rankings/tokenization are not automatically identical to our frozen reference. [1,2]
* **Semantic matching can help after lexical retrieval.** StackOne reports gains from tool-specific training, hard negatives, consistent formatting, and connector-level holdouts. Its published scores and deployment times are vendor reports, not predictions for our laptop. Do not assume its fine-tuned model is available or that our model will reproduce its result. [3]
* **A small model can run locally.** BGE-small-en-v1.5 has 384-dimensional outputs, a 512-token sequence limit, ONNX artifacts, and an MIT license. MiniLM-L6-v2 is a comparison candidate; its model card warns that inputs over 256 word pieces are truncated by default. Long documentation requires explicit formatting/chunking choices. Node ONNX bindings and Transformers.js local-model settings permit a local runtime. [4–7]
* **Combine lexical and dense ranks explicitly.** Reciprocal Rank Fusion combines ranks without calibrating unlike score scales. Its original constant is 60. This is a reasonable fixed experimental starting point, not proof of improvement on tools. [8]
* **Refresh can follow the protocol.** MCP supports paginated lists and `notifications/tools/list_changed`. Subscribe where supported, with a bounded background polling fallback for servers without notifications. [9]
* **Code Mode solves a different part of the workflow.** Cloudflare composes calls and processes results in isolated runtimes. That can reduce agent turns/output, but it does not repair our substring ranking. Our direct-call and data-query paths already avoid code for common requests; keep those paths. [10]

## Implementation sequence

### 1. Stage 1 delivered: indexed BM25 and a stable catalogue snapshot

The product now holds a `SearchIndex` per immutable catalogue-array snapshot and reuses it across searches. Upstreams preserve the array identity while tool references and error state remain unchanged, replacing the snapshot when they change. Exact server/tool filters remain available. Search never changes upstream execution names or returned schemas.

The local BM25 formula is k1=1.2, b=0.75 and log(1+(N-df+0.5)/(df+0.5)), with lowercase ASCII alphanumeric tokenization. Product documents include server alias + capability name + full description. The implementation stores postings and document lengths, uses numeric IDs/reusable score arrays, and selects a bounded top-k with deterministic ties. It only returns positive lexical matches for nonempty queries. Empty queries return the stable catalogue order.

The public-v10 audit uses benchmark queries to measure the product index, not tune it to reproduce the frozen name+description reference. The alias-bearing product index scores 0.295644 nDCG@10 versus 0.296189 for that reference; the user-searchable alias is retained. No database service or embedding dependency is required.

The validated search-query limit is 8,192 code units in both Zod and the exposed JSON Schema. Queries are rejected rather than truncated when over limit. The 24 KiB discovery response ceiling and fixed small tool-definition budgets remain in place.

Validation: 65 product tests and six metric checks passed. Public-v10 covers 44,453 fixture tools, but runtime discovery still caps at 5,000. It does not cover upstream IO, OAuth, TTL expiry, concurrent traffic, end-to-end answer quality, or billing. The local in-memory SDK measurements and cold index build are in the [public-v10 report](../benchmark/results/public-v10/README.md).

### 2. Next: refresh and scheduling

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

## Operational follow-up: targets, not measured promises

Pin hardware, Node version, corpus, scripts and query order. Warm latency means a ready catalogue/index and model, but an empty query-result cache. Report build/startup/refresh separately.

| Gate | Initial acceptance target |
|---|---|
| Stage 1 retrieval | **Measured:** full public suite product nDCG@10 0.295644, zero errors; frozen reference 0.296189. This is a product-usefulness measurement, not a ranking target |
| Query acceptance | **Measured:** all 7,961 original queries accepted; zero search errors |
| Lexical warm SDK, up to 5,000 tools | p50 ≤20 ms, p95 ≤50 ms on the designated CPU; not yet verified (the available 5,000-tool measurements are direct index calls, not SDK calls) |
| Lexical warm SDK, 44,453-tool fixture | p50 ≤50 ms, p95 ≤100 ms; report genuine worst cases and term/posting counts |
| Catalogue lifecycle | Add/remove/revoke reflected correctly; warm execution not blocked by unrelated discovery; no stale-permission calls |
| Memory | Initial lexical goal ≤512 MiB RSS at 44,453 tools; separately measure peak rebuild and optional model memory |
| Optional hybrid | Meaningful paired quality gain over the indexed lexical release, with p95 ≤100 ms at 5,000 tools and ≤150 ms at 44,453; otherwise remains optional |
| Context | Default still two tools; native profile still bounded to five additional tools and its existing definition budget; report schema/result tokens and actual usage separately |
| Small-result execution | Proposed warm gateway-added p50 ≤5 ms and p95 ≤15 ms versus the same direct upstream; verify over real stdio, not just in-memory transport |

Remaining targets are engineering goals. The v10 full-suite process-wide peak RSS is 631 MiB including benchmark data, above the initial 512 MiB target and not an isolated index measurement; the isolated 44,453-tool index retained 92.2 MiB heap after GC, with allocator-sensitive RSS delta of 220.4 MiB. The first cold SDK search is 916 ms; optimize or move index construction only after an operational startup/expiry study. Hybrid inference and runtime behavior on Windows/macOS/Linux remain unmeasured. Faster local search does not guarantee a faster final answer.

## Validation and release policy

1. Preserve the audited baseline and its complete infrastructure history. Run each candidate in a new directory. Record product, adapter, model, dataset and metric hashes. Audit all rankings with the independent official backend.
2. Run reference-equivalence tests for optimized BM25 and top-k, including ties, empty/no-match queries, filters, Unicode, repeated terms, long queries and catalogue replacement. Add lifecycle tests for paginated discovery, notification bursts, expired caches, removed servers, cancelled queues and failed refreshes.
3. For latency, use a prespecified randomized, category/source-stratified query sample with repeated matched runs. Include long/common-term queries, cache misses, 1/4/8 concurrent clients, startup, expiry and refresh storms. Run one full-corpus evaluator at a time within 8 GiB; the previous eight-worker OOM must not recur. Measure current 2/8/16/32-process configurations separately from distinct-implementation coverage.
4. Treat ToolRet as a public development benchmark once repeatedly used for optimization. Do not claim a fresh unseen test after tuning on it. Select field weights/models using separate development data, then freeze and evaluate previously unused ToolBench/MetaTool and connector-held-out operational tasks. No benchmark qrels or prompts in synthetic training, synonyms, summaries or native selections. Record known training/evaluation overlap and all tried configurations.
5. Native MCP-Atlas/end-to-end evaluation still needs a usable sandbox and native model/judge endpoint. Compare direct tools, client deferred tools where supported, lexical gateway and optional hybrid using the same model, budgets, permissions, tasks and original tool whitelists. At least three repetitions; retain wrong answers. Prespecify a five-percentage-point noninferiority margin for completion and inspect its paired interval. Measure gateway/direct warm answer latency ratio, actual input/output/cached usage and separately priced judge cost. A target ratio ≤1.10 is conditional on meeting quality; it is not a current result.
6. Stage 1 is the first retrieval improvement release. Treat benchmark scores as measurements of product behavior, not a leaderboard to optimize. Keep the public-v9 ranks frozen. Complete operational refresh, TTL, concurrency, startup and isolated memory work before considering semantic retrieval; do not couple it to fine-tuning, OAuth redesign or a language rewrite.

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
