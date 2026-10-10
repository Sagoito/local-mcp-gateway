# Security and limit verification

Date: 2026-10-10. Node.js 24.19.0, Linux. `npm test` passed all 85 tests with zero failures or skips. See [verification metadata](verification.json) for source hashes and the context diagnostic. The frozen public-v10 artifacts retain their original recorded hashes.

## Changes exercised

Tests cover exact allowlists across real stdio discovery, structured calls, native tools and JavaScript; guessed denied names; no denied-handler dispatch; policy revocation on config reload; code-disabled result filtering; UTF-8 argument limits at guest and host boundaries; cancellation before queued dispatch; conservative native annotations; OAuth URL validation; and a real loopback callback's state/duplicate handling.

Discovery regressions cover cached/fresh aggregate counts, UTF-8 metadata budgets, raw denied-tool accounting, page limits, invalid/duplicate names and repeated cursors, unchanged catalogue identity and cache expiry that is not extended by hits. A real stdio fixture verifies rejection of 5,001 tools with the 5,000 default and admission with an explicit 6,000 cap. This is not a claim of tested 50,000-tool live capacity.

## Warm latency regression diagnostic

The [runner](../../security-latency.mjs) compares the verified executable dist from the v10 audit bundle with the final built code. Both run as real gateway stdio processes, using the same SDK and real stdio upstream fixture with 5,000 generated tools. Four balanced pairs each have 20 warmup searches and calls, followed by 100 broad searches and 100 structured calls. Both use default unrestricted tool policies and enabled JavaScript; JavaScript is not executed in this timing test.

| Operation / condition | Measured calls | p50 | p95 | Maximum |
|---|---:|---:|---:|---:|
| Search / frozen v10 | 400 | 0.603 ms | 0.976 ms | 7.046 ms |
| Search / current | 400 | 0.640 ms | 1.111 ms | 3.314 ms |
| Structured call / frozen v10 | 400 | 0.938 ms | 1.705 ms | 4.269 ms |
| Structured call / current | 400 | 1.003 ms | 2.102 ms | 5.505 ms |

This synthetic check shows small absolute overhead in this setup, with no search-index rebuild on warm requests. It does not prove negligible overhead for every deployment. Within-process observations are correlated; there are four processes per condition, and no inferential speedup claim or confidence interval. Large allowlists, large arguments, expiry/rebuild, native profiles, startup, providers and answer quality are outside this measurement.

[Primary raw observations and hashes](latency.json) describe the final code. [An earlier run](latency-overlapped-tests.json) overlapped automated tests and is excluded from the primary comparison. [The next isolated run](latency-before-native-hints.json) predates the final conservative native-hint change and is also excluded. A preflight used a query that did not match the fixture's eight-character description token; its count assertion failed before producing a timing report. The query was corrected to match the fixture, without a product change.

## Context and scope

The default still exposes two MCP tools. Their JSON definitions are 3,160 bytes and 758 o200k proxy tokens, versus the frozen v10's 3,131 bytes and 753 proxy tokens. The difference is the explicit `additionalProperties:false` execution schema. This is a JSON-definition proxy, not provider usage or billed cost. Allowlist configuration stays local and does not advertise every tool schema.

The unchanged lexical ranker has its existing independent reference tests. No new full public retrieval evaluation, agent response-quality study, provider cost measurement or competitor comparison was performed for this release. Security controls and remaining limitations are documented in [SECURITY.md](../../../SECURITY.md).

## Reproduce

Build the current product with `npm ci && npm run build`. Extract the `dist/` files from the verified [v10 audit bundle](../public-v10/audit-bundle.tar.gz) into a directory under this project so that its imports resolve to the same installed dependencies. Verify those files against `distFilesBeforeSha256` in the v10 manifest, then run without concurrent test workloads:

```sh
node benchmark/security-latency.mjs /absolute/path/to/verified-v10/dist /tmp/security-latency.json
```

The runner validates results and checks that measured source/build files stay unchanged during execution. The fixture is synthetic and requires no credentials or external service.
