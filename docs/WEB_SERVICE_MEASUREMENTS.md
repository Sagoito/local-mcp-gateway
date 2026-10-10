# Web service transport measurements

These measurements compare a legacy stdio gateway session, the service's
Streamable HTTP endpoint, and the service's thin stdio bridge. They cover local
transport behavior for one synthetic upstream, without model inference.

## Result

Run on 2026-10-10 with Node v26.11.1, Linux x64. Five independently started
sessions per mode were tested; each session made ten warm-up calls followed by
100 timed calls. Modes were shuffled within each trial. Every startup includes
a spawned CLI process. Startup is elapsed time from beginning mode setup until
the MCP client connected and completed its first `tools/list`. Warm-call timing
is measured around `tools/call` for `execute` with the same structured
arguments.

| Mode                    | Startup p50 / p95 (ms, n=5) | Warm `execute` p50 / p95 (ms, n=500) |
| ----------------------- | --------------------------: | -----------------------------------: |
| Legacy stdio gateway    |               377.8 / 383.4 |                          0.69 / 1.46 |
| Service Streamable HTTP |               420.5 / 495.0 |                          1.59 / 3.34 |
| Thin stdio bridge       |               526.5 / 557.9 |                          2.07 / 4.15 |

All modes returned identical outputs and advertised identical gateway tools.
The compact JSON serialization of the tool definitions was 2,415 bytes and
590 `o200k_base` tokens. The cold startup times include the CLI process in all
modes; service HTTP starts the service process, while bridge startup also
starts its stdio connector process. Warm call p50 was lowest for the legacy
stdio gateway in this setup. These local measurements should not be generalized
as transport performance guarantees.

The harness also measured a second client's connection and initial tool
listing while the first client remained connected and had completed warm-up
calls. Joining the existing service over HTTP had p50/p95 of 8.1/8.6 ms (n=5);
joining through a newly spawned thin stdio bridge had 161.6/180.7 ms (n=5).
Starting an independent legacy gateway against the same configuration had
356.8/418.6 ms (n=5). The latter starts its own CLI and upstream fixture
process. This measures the cost of joining a live backend in this fixture; it
does not measure shared-upstream throughput under concurrent tool calls.

## Method and reproduction

`benchmark/web-service.mjs` creates a temporary configuration with
`inlineTools: []`, `security.allowCode: false`, and the deterministic
`examples/demo-server.mjs builds` fixture. It connects an MCP SDK client over
each transport, times initialization through initial tool discovery, warms each
session, and then measures repeated identical `execute` calls. It refuses to
report if tool definitions or results differ across modes. The service is
started through `node dist/cli.js --config CONFIG web --port 0`; the other modes
launch `dist/cli.js` as a child process. The second-agent comparison keeps the
first connection alive and compares an HTTP client and a new bridge process
joining the running service with a newly spawned legacy gateway.

After `npm run build` on a supported Node runtime, run:

```sh
node benchmark/web-service.mjs
```

An alternate absolute CLI path can be passed as the first argument. Trial
counts can be adjusted with `WEB_SERVICE_STARTUPS`, `WEB_SERVICE_CALLS`, and
`WEB_SERVICE_WARMUPS`; defaults are 5, 100, and 10 respectively. Results are
printed as JSON and temporary configuration and connection files are removed.

## Limits

This is a localhost synthetic measurement, not an end-to-end agent benchmark.
It uses no real OAuth flow, remote upstream, model inference, or model-quality
evaluation. The three cold-start paths have different service responsibilities:
the legacy gateway starts one gateway process, HTTP starts one service process,
and the bridge starts a service plus a connector process. The sample is small
and machine-specific; it should not be generalized into a performance
guarantee. No direct-upstream MCP comparison or shared-upstream throughput claim
follows from these measurements.
