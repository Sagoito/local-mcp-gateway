# Cold-start research and implementation plan

Research date: 2026-10-10. Status: proposal; no new performance results or production changes.

The implementation audit below describes the v10 baseline (`0c4b6e4`). The subsequent security update preserves catalogue identity across unchanged refreshes, fixes aggregate cached/fresh budgets and bounds discovery lookahead; see [security notes](../SECURITY.md). Persistent index restoration and daemon operation remain proposals.

## Recommendation

Build the tool index during an explicit preparation step, persist the prepared catalogue and index, and restore compatible generations on restart. Refresh upstreams independently and publish changed generations atomically. Offer a local daemon later for users who want to retain upstream connections between conversations.

Eager indexing alone moves work from the first search into startup. Persistence can avoid repeating it. A daemon can also avoid repeated upstream process creation and handshakes. These address different delays and need separate measurements.

## What the current implementation does

Code inspected: [`server.ts`](../src/server.ts), [`upstreams.ts`](../src/upstreams.ts), [`search.ts`](../src/search.ts), and the installed SDK protocol definitions.

| Finding                                                                        | Effect                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `serve()` awaits upstream `listTools()` before connecting its client transport | All discovery is on the client startup path                                      |
| Search constructs its BM25 index lazily                                        | The first query pays for tokenization, postings, statistics and ordering         |
| Discovery runs in batches of four                                              | One slow member blocks scheduling the next batch, even when other slots are free |
| Tool lists live only in memory, with a fixed 30-second TTL                     | Restart loses metadata; the next search after expiry waits for discovery         |
| Successful discovery creates new arrays even for identical tools               | Array-identity index caching rebuilds unchanged catalogues                       |
| Any configuration change recreates every upstream manager                      | Adding one server also discards unrelated connections and caches                 |
| A single promise queue serializes gateway calls                                | A slow request can delay independent searches and executions                     |

Existing connection promises already coalesce connection attempts per server. That mechanism can be extended to discovery and rebuilding rather than replaced.

The frozen [v10 results](../benchmark/results/public-v10/README.md) show:

| Measurement                                 |                   Result | Scope                                                             |
| ------------------------------------------- | -----------------------: | ----------------------------------------------------------------- |
| Index construction, 5,000 tools             |                 116.5 ms | One fresh-process diagnostic, deterministic corpus prefix         |
| Index construction, 44,453 tools            |                 939.1 ms | One fresh-process diagnostic, full corpus                         |
| First SDK search, 44,453 tools              |                 916.0 ms | Catalogue already supplied; excludes process and upstream startup |
| Warm SDK search, full suite                 | p50 2.44 ms; p95 6.70 ms | 7,961 measured queries after separate warmup                      |
| Retained index heap increment, 44,453 tools |                 92.2 MiB | After GC; allocator-sensitive RSS increment was 220.4 MiB         |

Sources: [memory diagnostic](../benchmark/results/public-v10/memory.json) and [full-suite manifest](../benchmark/results/public-v10/manifest.json). The large corpus is an index fixture, not proof of live 44,453-tool support: live discovery currently has a 5,000-tool cap. None of these numbers measures complete process-to-first-authorized-execution startup. There is no defensible percentage breakdown of that whole path yet.

## Established techniques and their fit

These are documented production techniques. Their applicability to this gateway is an engineering recommendation, not evidence of an already measured speedup here.

| Technique                                         | Industry example                                                                                                                  | Application here                                                                              | Priority |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| Persist prepared work with versioned invalidation | Vite caches pre-bundled dependencies on disk [1]                                                                                  | Save metadata plus the actual BM25 index; restore without retokenizing                        | First    |
| Refresh independently of the query                | Lucene shares a current searcher while a replacement is prepared [2]; Caffeine refreshes asynchronously and deduplicates work [3] | Retain an eligible catalogue generation while building its replacement                        | First    |
| Coalesce misses and bound dependency traffic      | AWS caching guidance [4]; Go `singleflight` [5]                                                                                   | One discovery/build per upstream generation; a four-slot work queue with immediate slot reuse | First    |
| Keep the execution engine alive                   | Gradle Daemon retains a background process [6]                                                                                    | Optional local daemon, thin MCP stdio adapters, idle timeout                                  | Second   |
| Cache runtime compilation                         | Node module compile cache [7]                                                                                                     | Measure import/compile startup separately; enable only if useful                              | Second   |
| Restore initialized runtime state                 | Lambda SnapStart snapshots initialized environments [8]; Node supports startup snapshots [9]                                      | A later alternative if ordinary data restoration remains expensive                            | Defer    |
| Query a persistent inverted index                 | SQLite FTS5 [10]                                                                                                                  | Alternative storage/search experiment if JS restoration or memory dominates                   | Defer    |

The strongest lesson from snapshot systems is to reuse prepared work. Whole-process snapshots are unnecessary for the first implementation. AWS warns that restored connections and temporary credentials need validation; Node startup snapshots require matching version, architecture and platform, plus compatible flags and CPU features. This complicates a portable gateway with changing user configuration.

Node's V8 serialization API supports disk storage of structured data [11]. Start with a versioned data-only snapshot using that API. Benchmark read, deserialize, validate and attach time against rebuilding. A snapshot may allocate many JS objects, so faster restoration is a hypothesis until measured. Packed typed arrays are a follow-up if allocation dominates. Workers are useful for CPU work, not network I/O [12]; they protect responsiveness during rebuild but do not remove the CPU cost or transfer overhead.

FTS5 offers persistent indexing, but its tokenizer, ranking and query syntax differ from this implementation. It is not a drop-in preservation of the current results. Keep that experiment separate from lifecycle changes and assess retrieval quality independently.

## Proposed lifecycle

### Preparation and restoration

Add a local `warm` command that connects to configured upstreams, discovers tools, builds the index and saves a complete generation. Preparation after an explicit login can be an option. Warmup must only discover metadata and prepare search, without invoking business tools.

Persist tool metadata and schemas, postings, term statistics, document normalization, stable ordering and filter lookups. Recreate mutable query scratch buffers on restoration. Do not persist transport objects, result stores, executable closures, sandbox state or credentials in the index.

A manifest should identify the format, tokenizer/ranker version, canonical catalogue content fingerprint, relevant resolved configuration and authorization context, and original fetch/expiry times. Hash canonical input content, not serialization bytes: equal JS values need not produce identical V8 serialization. Changing a server's configuration should invalidate its contribution; unchanged content should retain its index identity. Configuration fingerprints alone cannot prove upstream tool contents have stayed the same.

Write a bounded snapshot to a private local directory using temporary files and atomic publication. Validate format, size, integrity, document IDs and generation consistency before use. Coordinate multiple writers. A corrupt, incompatible, expired or inaccessible cache falls back to discovery/build. State the crash-durability guarantee explicitly when choosing whether to fsync. Avoid raw secrets in filenames or logs.

### Startup and refresh

Connect the lightweight MCP interface promptly. Restore eligible cached generations without waiting for every upstream to connect. Keep discovery readiness distinct from interface readiness. Preserve the default two gateway tools and existing bounded inline/native profiles; indexing thousands of tools locally does not require exposing their schemas in the initial prompt.

Use per-upstream states such as ready, refreshing, unavailable and authorization-required. Search responses must identify incomplete coverage instead of representing an undiscovered catalogue as an authoritative empty result. An uncached search can await relevant discovery within its deadline; execution needs only its selected upstream connection.

Replace four-at-a-time batches with a bounded queue. Coalesce discovery and rebuild work, publish the catalogue and index together, and discard obsolete rebuilds. Subscribe to tool-list changes where supported. Compare canonical contents after refresh; unchanged metadata must not trigger a rebuild. Diff configuration so unrelated upstreams remain connected.

Remove discovery and long execution from the global request queue only with explicit lifecycle coordination. Searches can capture immutable generations; cancellation, config changes and retained-result access still require correct ownership. A worker can construct replacements without freezing the MCP event loop. Measure the transient memory of both old and new generations.

Initially rebuild global BM25 statistics when catalogue membership changes. Later reuse tokenized unchanged documents. Do not combine separately normalized server scores as though they equal a global index: document frequency, corpus size and average length affect ranking.

### Freshness and authorization

The 2026-07-28 MCP specification defines `ttlMs` and `cacheScope`, notification invalidation, and per-page cache behavior [13]. Private responses are tied to authorization context, including access token. TTL is not a polling schedule; polling requires jitter and backoff. A consistent full catalogue should be re-fetched from its beginning. Older servers require local caching heuristics.

The installed SDK 1.32.1 negotiates up to 2025-11-25 and lacks those cache fields. Handle its existing notification protocol first; evaluate the newer protocol as a separate compatibility change.

Never promote an expired snapshot to fresh merely because the process restarted. Reject implausible timestamps. Credentials, account switches and server removal invalidate affected visibility immediately. Use a bounded, explicit legacy freshness policy. If offering stale discovery, expose its status and limit it to the same authorization context; keep stale native schemas out of direct tool advertisements. Treat authorization failures as invalidation, not an availability-only refresh error. Cached metadata does not authorize execution.

### Optional daemon

A daemon retains both the index and upstream processes between sessions; disk restoration retains only prepared data. Restrict IPC to the OS user and isolate each MCP client's result handles, cancellation and sandbox state. Include version negotiation, recovery from daemon crashes, duplicate-start coordination and idle shutdown. Keep ordinary stdio operation available. The daemon trades continuing RAM/process use for latency and deserves separate setup and memory evaluation.

## Experiment and release plan

1. Instrument process launch, config/import work, MCP handshake, per-upstream spawn/connect/list, index build or restoration, first successful search and first authorized execution. Record event-loop delay and memory, including all child processes for daemon comparisons.
2. Compare the current implementation, eager indexing, persistent restoration, independent refresh, and optional daemon. Measure module compile caching separately before combining it. Eager indexing must be evaluated from process launch, not just after its readiness barrier.
3. Distinguish an empty cache on first setup, a fresh process with retained disk cache, an expired cache, and a new client joining an existing daemon. Record filesystem/OS cache conditions without claiming a freshly launched process implies cold disk pages.
4. Use real stdio and existing filesystem/memory MCP installations, plus controlled slow/failing upstream fixtures. Exercise 2, 8 and 32 configured servers; identify replicated instances separately from distinct implementations. Use 5,000 tools for the live cap and 44,453 only as an index stress fixture until that cap changes.
5. Run at least 30 independent process starts per condition in randomized order on fixed hardware. Report count, p50/p95, uncertainty and timeout/failure rates. Query repetitions within a process are not independent cold-start samples. Count preparation time and disk usage separately.
6. Exercise identical TTL refresh, one-tool changes, pagination, notification invalidation, add/remove, account/token changes, expired credentials, offline servers, interrupted writes, corrupt snapshots and unwritable cache directories. Test 1, 4 and 8 simultaneous clients during refresh, including daemon session isolation.
7. Require unchanged ranked IDs and scores for an identical catalogue, unchanged schemas and exposure budgets, and no unauthorized visibility or calls. Use the existing untouched public suite as regression evidence; do not tune caching or ranking against relevance labels. Also check operational usefulness under partial availability.

The primary acceptance criterion is lower process-to-first-successful-search and process-to-first-authorized-execution latency across realistic restart scenarios, with comparable warm latency and correct lifecycle behavior. A shorter handshake alone does not meet it. Set numerical startup targets after the instrumented baseline; no speculative speedup is a release claim.

Recommended implementation order: phase timing → immutable generation/content identity and eager preparation → persistent index restoration → independent discovery/refresh and config diffing → optional daemon. Keep runtime snapshots and FTS5 as measured alternatives if those steps leave a material bottleneck.

## Sources

1. [Vite dependency pre-bundling and disk-cache invalidation](https://vite.dev/guide/dep-pre-bundling)
2. [Lucene SearcherManager](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/SearcherManager.html)
3. [Caffeine refresh semantics](https://github.com/ben-manes/caffeine/wiki/Refresh)
4. [AWS Builders' Library: caching challenges and strategies](https://aws.amazon.com/builders-library/caching-challenges-and-strategies/)
5. [Go singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight)
6. [Gradle Daemon](https://docs.gradle.org/current/userguide/gradle_daemon.html)
7. [Node 24.19.0 module compile cache](https://nodejs.org/download/release/v24.19.0/docs/api/module.html#module-compile-cache)
8. [AWS Lambda SnapStart and compatibility considerations](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html)
9. [Node startup snapshot compatibility](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#--snapshot-blobpath)
10. [SQLite FTS5](https://www.sqlite.org/fts5.html)
11. [Node V8 serialization](https://nodejs.org/download/release/v24.19.0/docs/api/v8.html#serialization-api)
12. [Node worker threads](https://nodejs.org/download/release/v24.19.0/docs/api/worker_threads.html)
13. [MCP 2026-07-28 caching specification](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)
