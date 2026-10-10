# Weftly

Weftly brings your MCP servers into one local workspace. Manage connections in a browser dashboard, review tool access, and give an agent a private connection to the gateway.

Keep the agent's initial tool catalogue small with `search` and `execute`. Upstream schemas are discovered when needed; selected tools can also be exposed directly. One running backend shares connections across agents, while each agent keeps its own retained results.

## Start the local dashboard

Requires Node.js 26.11.1 or later. Weftly is currently installed from this repository; it is not published as an npm package.

```sh
git clone https://github.com/Sagoito/local-mcp-gateway.git
cd local-mcp-gateway
git checkout feature/web-control-plane
npm ci
npm run build
node dist/cli.js web
```

Open the local dashboard URL printed by the command. Keep the process running while you use the dashboard or connect an agent. The service is single-user and loopback-only. It manages the configuration and upstream sign-ins, and command-based servers run on the machine hosting Weftly. Remote hosting is future work.

Add a server in the dashboard, or import a supported client configuration for review before adding it. Import reads the source as text and leaves the original file unchanged. Use **Set up a client** to select a client and copy its generated agent entry. The entry uses a private connection file and does not contain the web administrator credential. Keep the Weftly service running while the agent uses that entry.

## Existing CLI workflows

The previous `local-mcp` command remains available as a legacy alias. The new executable is `weftly`; install either command for your shell with `npm link` from the repository after building. The CLI workflows remain useful for scripting and manual configuration:

```sh
weftly setup ~/.copilot/mcp-config.json --client copilot --dry-run
weftly doctor
weftly import /path/to/another-client.json --server new-server
weftly client-config --client vscode
weftly list
weftly remove server-name
weftly add new-server --url https://example.com/mcp
```

`setup` can import compatible servers and print a ready-to-paste agent entry. `import` adds servers without generating an entry; `client-config` prints an entry without changing configuration. See [configuration and advanced usage](docs/USAGE.md) for migration behavior, authentication, limits, manual setup, and execution examples.

## Security and scope

Weftly is a single-user local tool proxy. Stdio subprocesses run with your OS permissions. An allowed tool can still perform harmful actions through its arguments; approval of an outer `execute` call is not approval enforcement for every nested action. The gateway proxies tools over stdio and Streamable HTTP, with discovery, argument, output, and execution limits. It does not proxy upstream prompts/resources or support legacy SSE.

The dashboard is for local use and is not a remotely hosted multi-user service. Read the [security model](SECURITY.md) before using privileged tools. For contributors, `npm run check` runs linting, formatting, types, tests, and package validation; see [contributing](CONTRIBUTING.md) and [quality and security checks](docs/QUALITY_SECURITY.md).

## Development and measurements

```sh
npm test
```

See the [evaluation results and comparison limits](docs/USAGE.md#evaluation-and-comparison-limits), [benchmark protocol](benchmark/COMPARABILITY_PLAN.md), [latency design](docs/latency-design.md), and [cold-start plan](docs/COLD_START_PLAN.md). Retrieval benchmarks do not establish general answer quality or billed savings. Historical benchmark reports and results are retained as recorded.

The [web transport measurements](docs/WEB_SERVICE_MEASUREMENTS.md) compare first connections, additional agents, and warm calls. The [control-plane design](docs/WEB_CONTROL_PLAN.md) describes the local backend and future hosting boundary.

[MIT license](LICENSE).
