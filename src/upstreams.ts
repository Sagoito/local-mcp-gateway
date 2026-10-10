import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expandEnv } from './config.js';
import type { GatewayConfig, ServerConfig, ToolEntry, Upstreams } from './types.js';
import { createAuthProvider } from './auth.js';

const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TOOL_CACHE_TTL_MS = 30_000;

type Connection = { client: Client; transport: Transport };

/** Create lazy, reusable connections to configured MCP servers. */
export function createUpstreams(config: GatewayConfig, configPath: string): Upstreams & { getErrors(): Record<string, string> } {
  const live = new Map<string, Promise<Connection>>();
  const errors: Record<string, string> = {};
  const toolCache = new Map<string, { expires: number; tools: ToolEntry[] }>();
  const entries = Object.entries(config.servers).filter(([, value]) => !value.disabled);

  const connect = async (server: string, serverConfig: ServerConfig): Promise<Connection> => {
    const client = new Client({ name: 'local-mcp-gateway', version: '0.1.0' });
    let transport: Transport;
    if ('command' in serverConfig) {
      transport = new StdioClientTransport({
        command: expandEnv(serverConfig.command),
        args: serverConfig.args?.map(expandEnv),
        env: Object.fromEntries(Object.entries(serverConfig.env ?? {}).map(([k, v]) => [k, expandEnv(v)])),
        stderr: 'ignore',
      });
    } else {
      const headers = Object.fromEntries(Object.entries(serverConfig.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]));
      const authProvider = createAuthProvider(server, serverConfig, configPath, false);
      transport = new StreamableHTTPClientTransport(new URL(expandEnv(serverConfig.url)), {
        requestInit: { headers },
        authProvider,
      });
    }
    client.onclose = () => { live.delete(server); toolCache.delete(server); };
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connection to ${server} timed out`);
      return { client, transport };
    } catch {
      await transport.close().catch(() => undefined);
      throw new Error(`Unable to connect to upstream server "${server}"`);
    }
  };

  const get = (server: string): Promise<Connection> => {
    const cfg = config.servers[server];
    if (!cfg || cfg.disabled) throw new Error(`Unknown upstream server "${server}"`);
    let p = live.get(server);
    if (!p) {
      p = connect(server, cfg).catch(error => { live.delete(server); throw error; });
      live.set(server, p);
    }
    return p;
  };

  return {
    async listTools(): Promise<ToolEntry[]> {
      const all: ToolEntry[] = [];
      let discovered = 0;
      for (const name of Object.keys(errors)) delete errors[name];
      for (let i = 0; i < entries.length; i += 4) {
        await Promise.all(entries.slice(i, i + 4).map(async ([server]) => {
          const cached = toolCache.get(server);
          if (cached && cached.expires > Date.now()) { all.push(...cached.tools); return; }
          const tools: ToolEntry[] = [];
        try {
          const { client } = await get(server);
          let cursor: string | undefined;
          let pages = 0;
          do {
            if (++pages > 100) throw new Error('pagination limit exceeded');
            const result = await withTimeout(client.listTools(cursor ? { cursor } : {}, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), REQUEST_TIMEOUT_MS, `Listing tools on ${server} timed out`);
            for (const tool of result.tools) {
              if (++discovered > 5000) throw new Error('tool limit exceeded');
              tools.push({ server, name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema as Record<string, unknown>, ...(tool.annotations ? {annotations:tool.annotations} : {}) });
            }
            cursor = result.nextCursor;
          } while (cursor);
          toolCache.set(server, { expires: Date.now() + TOOL_CACHE_TTL_MS, tools });
          all.push(...tools);
        } catch {
          errors[server] = serverConfigError(config.servers[server]);
        }
        }));
      }
      return all.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
    },
    getErrors(): Record<string, string> { return { ...errors }; },
    async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
      const { client } = await get(server);
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const result = await withTimeout(client.callTool({ name: tool, arguments: args }, undefined, { signal: combined }), REQUEST_TIMEOUT_MS, `Tool call on ${server} timed out`);
        return result;
      } catch (error) {
        if (signal?.aborted) throw new Error('Tool call cancelled');
        if (error instanceof Error && error.message.startsWith('Tool call on ')) throw error;
        throw new Error(`Tool call failed on upstream server "${server}"`);
      }
    },
    async close(): Promise<void> {
      const connections = await Promise.allSettled([...live.values()]);
      await Promise.all(connections.flatMap(r => r.status === 'fulfilled' ? [r.value.transport.close().catch(() => undefined)] : []));
      live.clear();
    },
  };
}

function serverConfigError(cfg: ServerConfig): string {
  return 'command' in cfg ? 'Could not connect or discover tools from this stdio upstream' : 'Could not connect or discover tools; if authorization is needed, run local-mcp login <server-name>';
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer!));
}
