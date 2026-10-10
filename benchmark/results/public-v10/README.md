# Public-v10: indexed product search

## Result

Stage 1 replaces per-query substring scanning with a cached local BM25 index. On the full ToolRet public development retrieval fixture, product search scored **0.295644 nDCG@10** versus **0.296189** for the frozen local BM25 reference. Both conditions completed all 7,961 queries with zero errors. The independent paired query bootstrap found a product-minus-reference nDCG@10 interval of **[-0.000887, -0.000234]** (95% percentile interval, 1,000 resamples). Product search deliberately includes configured server alias + capability name + full description; the frozen reference uses capability name + full description. This metadata distinction, along with other ranking details, is not isolated by an ablation, so the score difference is not attributed to aliases alone. We retain server aliases because users search for configured connector names. The benchmark measures product behavior; it is not a ranking target, and no synthetic alias special case or benchmark-specific tuning was added.

| Condition | nDCG@10 | Hit@10 | MRR@10 | Errors |
|---|---:|---:|---:|---:|
| Product indexed BM25 | 0.295644 | 0.478081 | 0.313739 | 0 |
| Frozen BM25 reference | 0.296189 | 0.479337 | 0.314206 | 0 |
| Historical public-v9 gateway | 0.063799 | 0.121593 | 0.063071 | 360 |

All **360** original queries longer than the old 500-character limit were accepted with the new 8,192-code-unit limit. The complete public fixture contains **44,453 tools, 7,961 queries, and 14,106 relevance labels**. Queries and relevance labels are unchanged; there are no generated instructions, qrel hints, rewrites, or silent truncations. The independent audit passed all metric checks.

The historical gateway row is the public-v9 result on the full original query set: its old 500-character input limit rejected 360 queries, which score as empty rankings in the primary denominator. It is included for improvement context, not as the paired latency comparison condition; the paired speed run uses a separate 90-query sample and its exact compiled source is pinned in the latency manifest.

## Latency and memory

The runner first made ten fixed warmup calls, then measured the complete original sequence of **7,961 queries**, including those ten a second time. Sequential local SDK latency was **2.44 ms p50**, **6.70 ms p95**, **13.65 ms p99**, and **44.56 ms max**. The first cold search took **916 ms**, including index initialization; the ten warmup calls took 942 ms total. Peak observed process RSS was **661,360,640 bytes (about 631 MiB)**. This is process-wide and includes the gateway, index, SDK, and benchmark data, not an isolated index measurement.

The same-SDK paired latency diagnostic sampled **90 seeded queries** (30/category, each ≤500 UTF-16 code units) and ran two balanced-order repetitions, for **180 paired observations / 360 individual SDK search calls** and zero errors in both conditions. Old gateway p50/p95 were **417.88/834.70 ms**; indexed gateway p50/p95 were **2.59/4.92 ms**. The median paired old/new speed ratio was **177.94×**; the ratio of the two medians is 161.4×. Separately, the mean paired ratio was **191.02×**, with a 95% query-bootstrap interval of **177.84×–205.06×**. These are different summaries. The sample is seeded and category-stratified, not source-stratified. Its confidence interval captures query sampling only, not system/provider/network variance. Both conditions expose two tool definitions: old **3,130 JSON bytes / 752 o200k token proxy**, new **3,131 bytes / 753 proxy**. Token proxies are not provider usage or billed tokens. First cold search was **693.5 ms** old and **883.6 ms** indexed, so cold initialization did not improve. These local in-memory SDK timings are not answer latency.

A separate fresh-process index-only diagnostic measured a deterministic first-5,000-tools subset and the full 44,453-tool fixture. At 5,000, index construction took **116.5 ms**, retained heap delta after GC was **12.0 MiB**, and retained RSS delta was **14.3 MiB**. At 44,453, construction took **939.1 ms**, retained heap delta was **92.2 MiB**, and retained RSS delta **220.4 MiB**. Ten fixed direct index lookups after construction had maximum latency **0.52 ms** (5,000 tools) and **2.57 ms** (44,453 tools). The 5,000-tool diagnostic is not SDK latency and does not verify the SDK warm-latency target. Memory deltas are allocator-dependent; the raw diagnostic records process and OS peak scopes.

## Scope and limits

This is retrieval-only evaluation using the local MCP SDK over `InMemoryTransport`, with an in-memory catalogue. It does not measure answer quality, model/provider usage, billing, upstream I/O, OAuth, expiry refresh, startup of the full application, or concurrent-client behavior. The 90-query paired sample was not source-stratified. The fixture has 44,453 tools, while production discovery currently caps newly discovered tools at 5,000. The release passed **65 product tests** and **6 metric checks**; these product tests are operational/unit checks, not agent answer grading or MCP-Atlas runs.

The BM25 formula is k1=1.2, b=0.75, and idf `log(1+(N-df+0.5)/(df+0.5))`; product tokenization is lowercase `[a-z0-9]+`. Product documents include server alias + tool name + description, with bounded top-k selection and deterministic ties. The frozen reference ranks are reused byte-for-byte from public-v9 and use only tool name + description. Public-v10 is a public development benchmark, not a held-out test or an exact vendor comparison.

## Reproduction

From the repository root, prepare the public dataset and build the exact product snapshot under test, then write a fresh run directory:

```bash
npm ci
npm run build
python -m venv .local/public-venv
.local/public-venv/bin/pip install -r benchmark/public-requirements.txt
.local/public-venv/bin/python benchmark/public-prepare.py
node --test benchmark/public-retrieval.test.mjs
node benchmark/indexed-retrieval.mjs .local/public-data/toolret-full.json benchmark/results/public-v9 .local/public-v10-repro
.local/public-venv/bin/python benchmark/public-audit.py .local/public-data/toolret-full.json .local/public-v10-repro
```

Use `public-prepare.py --offline` after the initial download. Keep outputs in a new directory; do not overwrite this audited run or public-v9. The source dataset is downloaded locally and is not redistributed here.

To reproduce the paired latency diagnostic, extract the pinned old `dist` from the v9 audit bundle and build the current product before running:

```bash
mkdir -p .local/public-v9-old
tar -xzf benchmark/results/public-v9/audit-bundle.tar.gz -C .local/public-v9-old dist
node benchmark/indexed-latency.mjs .local/public-data/toolret-full.json .local/public-v9-old/dist .local/public-v10-latency-repro
node benchmark/indexed-memory.mjs .local/public-data/toolret-full.json .local/public-v10-memory-repro.json
```

The paired runner checks the old compiled server hash. The separate memory/lookup runner uses one fresh child process per catalogue size; its direct index calls are not SDK latency.

## Artifacts

- [Run manifest, scores, timing, memory, and source hashes](manifest.json)
- [Independent audit and paired query bootstrap](audit.json)
- [Public-v10 audit bundle](audit-bundle.tar.gz)
- [Public-v10 retained artifact manifest](artifacts.json)
- [Frozen protocol and scope](protocol.json)
- [Product gateway rankings](gateway.jsonl.gz)
- [Frozen public-v9 BM25 reference rankings](../public-v9/bm25.jsonl.gz)
- [Paired SDK latency manifest](latency/manifest.json)
- [Paired latency trials](latency/trials.jsonl)
- [Paired latency summaries](latency/pairs.jsonl)
- [Full-suite and 5,000/44,453-tool index-only memory diagnostics](memory.json)
- [Public-v9 baseline run and its audit](../public-v9/README.md)
- [Frozen public-v9 source and compiled gateway archive](../public-v9/audit-bundle.tar.gz)
- [Public-v9 retained artifacts manifest](../public-v9/artifacts.json)
- [Indexed retrieval runner](../../indexed-retrieval.mjs)
- [Comparison protocol](../../COMPARABILITY_PLAN.md)

Raw rankings contain IDs and query hashes rather than source query text. Preserve the source dataset's terms when reproducing or redistributing artifacts.
