# Local MCP Gateway

Use the MCP servers you already have through one local gateway. Your agent sees `search` and `execute` by default, with bounded tool descriptions instead of every upstream schema. The gateway discovers tools and makes structured calls on demand. Optional JavaScript and up to five directly exposed tools support more advanced workflows.

## Install once

Requires Node.js 22 or newer. Install from this repository; there is no published npm package yet.

```sh
git clone https://github.com/Sagoito/local-mcp-gateway.git
cd local-mcp-gateway
npm ci
npm run build
npm link
```

`npm link` makes `local-mcp` available on your machine. You can also run `node dist/cli.js` from this directory without linking.

## Bring your existing MCPs

For Copilot CLI:

```sh
local-mcp setup ~/.copilot/mcp-config.json --client copilot
```

This imports the supported servers into the gateway and prints the ready-to-paste gateway entry with absolute executable and configuration paths. Replace the imported direct server entries in your agent with this entry, keep other client settings, and restart the agent. Keeping both connections advertises duplicate tools and defeats the context savings. Your original file is left intact until you edit it.

Other supported configurations:

| Your configuration | Command |
|---|---|
| VS Code workspace | `local-mcp setup .vscode/mcp.json --client vscode` |
| OpenCode | `local-mcp setup opencode.jsonc --client opencode` |
| JSON with `mcpServers` | `local-mcp setup /path/to/client.json --client generic` |

Run these from the workspace where the original servers run, or pass `--workspace /path/to/project`. Relative commands, arguments, and working directories need that workspace. `${workspaceFolder}` is resolved there. JSON comments and trailing commas are supported.

Preview before switching:

```sh
local-mcp setup ~/.copilot/mcp-config.json --client copilot --dry-run
local-mcp doctor
```

Preview does not write files or start upstream servers. `doctor` connects to enabled upstreams, checks discovery, and exits unsuccessfully if any server is unavailable. It does not invoke their tools. Disabled entries remain disabled.

The import is a snapshot of the specified file. Re-running it accepts identical entries and adds new names; conflicting entries or unsupported settings block the entire write. To migrate only compatible servers, repeat `--server NAME`. Client-specific approvals, sandbox rules, inherited settings, built-in servers, plugin servers, and enterprise policies are not transferred. Review those before switching; explicit unsupported policies in the file block import.

## Authentication

You do not need to recreate commands, arguments, environment maps, or HTTP headers for supported entries. Import preserves credential references instead of resolving them into secrets.

| Existing authentication | What happens |
|---|---|
| API key or bearer header in the file | Header is copied to the private gateway config; environment references stay references. |
| Environment variables | `${NAME}`, `${env:NAME}`, and `{env:NAME}` become gateway references. Copilot `$NAME` in environment values/headers is supported. Set variables in the process that launches the gateway. |
| Auth handled by a stdio executable or wrapper | The same command is retained. Its existing credentials may continue to work under the same OS user, home and working directory. |
| OAuth handled by the agent | Sessions and keychain tokens are not copied. Sign in once through the gateway if the provider supports its flow. |
| Client-specific prompts, OIDC, custom scopes/grants, env files, environment-dependent working directories, or sandbox rules | Import stops with a per-server explanation instead of dropping the setting. Keep that server direct until it has a supported configuration. |

For a compatible OAuth server:

```sh
local-mcp login server-name
```

The gateway supports authorization code with PKCE and optional pre-registered client IDs. Its callback is `http://127.0.0.1:43127/callback`; the provider must accept it. OAuth-disabled OpenCode entries remain disabled. Vendor compatibility is not guaranteed, and browser sign-in has not been tested against every provider. Desktop agents may not inherit your shell environment; add required variables to their gateway entry using the client's environment field.

Configuration files and OAuth tokens are plaintext with restricted POSIX permissions. Use a user-private directory on Windows. Literal credentials present in an imported file are copied, but import diagnostics and generated agent entries do not print them. [Authentication details and manual setup](docs/USAGE.md#connect-upstream-servers).

## Keep managing MCPs locally

```sh
local-mcp import /path/to/another-client.json --server new-server
local-mcp client-config --client vscode
local-mcp list
local-mcp remove server-name
local-mcp add new-server --url https://example.com/mcp
```

`import` adds servers without generating an agent entry; `client-config` prints an entry without changing anything. Use `--config PATH` on every command if you want a nondefault gateway configuration. Add/remove and policy edits take effect on the next gateway request.

## Security and scope

New configurations created by `setup` or `import` disable JavaScript. Structured tool calls and retained JSON filtering work without it. Existing configurations retain their settings. Imported exact-name tool filters become enforced allowlists; an empty filter denies all tools, and a sole `*` permits all. Other wildcard filters are rejected.

This is a single-user local tool proxy. Stdio subprocesses run with your OS permissions. An allowed tool can still perform harmful actions through its arguments; approval of `execute` is not approval enforcement for every nested action. The gateway proxies tools over stdio and Streamable HTTP, with discovery, argument, output, and execution limits. It does not proxy upstream prompts/resources or support legacy SSE.

Read the [security model](SECURITY.md) before using privileged tools. [Limits, manual configuration, execution examples, and native tools](docs/USAGE.md) are documented separately.

## Development and measurements

```sh
npm test
```

Tests include configuration migration, a generated entry launching the gateway from another directory, real stdio calls, allowlists, disabled OAuth, sandbox limits, and mocked SDK OAuth flows. This is not a claim of end-to-end compatibility with every agent or OAuth vendor.

See the [evaluation results and comparison limits](docs/USAGE.md#evaluation-and-comparison-limits), [benchmark protocol](benchmark/COMPARABILITY_PLAN.md), [latency design](docs/latency-design.md), and [cold-start plan](docs/COLD_START_PLAN.md). Retrieval benchmarks do not establish general answer quality or billed savings.

[MIT license](LICENSE).
