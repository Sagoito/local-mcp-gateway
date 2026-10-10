# Paired local MCP benchmark

Compare official filesystem and memory MCP servers connected directly (all tool schemas listed eagerly) with the same servers behind this gateway (only search and execute listed). No fixture content is injected into either prompt. Both use an identical generic shell mailbox bridge to real SDK clients and real stdio processes.

## Questions and data

Frozen prompts and scoring answers are in questions.json; agents receive prompts only. Six questions cover region lookup, runbook discovery, filtering 300 incidents by severity/state/time, an incident-to-memory ownership join, two small file reads, and two dependency hops followed by a runbook lookup. Fixtures are deterministic and synthetic. incidents.json is 182,377 bytes. Each run has its own memory store; filesystem fixtures are shared and tasks are read-only.

## Execution

Six questions × two conditions × two repetitions = 24 fresh gpt-6-luna agents with medium reasoning. Maximum 12 tool calls after the initial list. Agents cannot read harness files or answer keys, process results through host shell/JavaScript, or access data outside the MCP bridge. Gateway agents may process data inside execute. This restriction tests MCP-only workflows; it does not compare a shell-enabled coding agent that filters files itself.

Alternate requested condition order across tasks/repetitions, with up to four concurrent agents. Actual timestamps are in audit logs. Temperature and hidden model settings are not exposed. The session was interrupted after the initial tasks: an unfinished q1-gateway-r1 was archived and restarted with a fresh agent. Its incomplete events remain as interrupted-events.jsonl; no completed wrong answer is rerun or discarded.

## Measurements

Score exact JSON equality against frozen answers. Keep all wrong answers and errors. Record schema bytes, serialized request/result bytes and o200k_base token proxies, final accumulated payload, and cumulative replay input proxy. These are not provider-reported Luna tokens. No billing API or actual Luna rates are available. Normalize input/output proxies to a hypothetical $1 per million tokens, with no cache discounts; do not call this actual spend.

Measure elapsed time from first list request to finish request, including orchestration, and separately measure MCP RPC durations including cold list setup. Small n=2 and concurrent scheduling make timing descriptive, not statistically conclusive. Large output may be truncated by the host even when the daemon logs the full payload: payload size is not proof all bytes reached the model. This is an eager-schema baseline, not Copilot's native deferred discovery.

## Reproduce

```
npm ci
npm run build
node benchmark/prepare.mjs /absolute/path/to/fresh-runs
node benchmark/daemon.mjs /absolute/path/to/fresh-runs
```

In a separate controller, create one fresh agent per prompt.txt in order.json, passing only that instruction file. Do not supply config.json (contains scoring answers). Agents run bridge list/call/finish commands from their prompt. No model runner/API key is bundled. Once finished:

```
node benchmark/analyze.mjs /absolute/path/to/fresh-runs benchmark/results/local-luna
```

Package-lock pins actual server versions. The gateway core is unchanged during these runs. Live OAuth vendor sign-in, remote HTTP latency, native deferred-tool clients, realistic production corpora, and actual billed costs remain outside this experiment.
