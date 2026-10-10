import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHash } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expandEnv, validateHttpUrl } from './config.js';
import type { GatewayConfig, ServerConfig, ToolEntry, Upstreams } from './types.js';
import { createAuthProvider } from './auth.js';
import { assertCallArguments, assertToolAllowed, isToolAllowed, LIMIT_DEFAULTS } from './policy.js';

const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TOOL_CACHE_TTL_MS = 30_000;

type Connection = { client: Client; transport: Transport };

/** Create lazy, reusable connections to configured MCP servers. */
export function createUpstreams(config: GatewayConfig, configPath: string): Upstreams & { getErrors(): Record<string, string> } {
  const live = new Map<string, Promise<Connection>>();
  const errors: Record<string, string> = {};
  const toolCache = new Map<string, { expires: number; tools: ToolEntry[]; visible: ToolEntry[]; rawCount: number; rawBytes: number; fingerprint: string }>();
  const entries = Object.entries(config.servers).filter(([, value]) => !value.disabled).sort(([a], [b]) => a.localeCompare(b));
  const limits = { ...LIMIT_DEFAULTS, ...config.limits };
  let snapshotParts = new Map<string, ToolEntry[]>();
  let snapshotErrors = '';
  let aggregateSnapshot: ToolEntry[] | undefined;

  const connect = async (server: string, serverConfig: ServerConfig): Promise<Connection> => {
    const client = new Client({ name: 'local-mcp-gateway', version: '0.1.0' });
    let transport: Transport;
    if ('command' in serverConfig) {
      transport = new StdioClientTransport({
        command: expandEnv(serverConfig.command),
        args: serverConfig.args?.map(expandEnv),
        cwd: serverConfig.cwd ? expandEnv(serverConfig.cwd) : undefined,
        env: Object.fromEntries(Object.entries(serverConfig.env ?? {}).map(([k, v]) => [k, expandEnv(v)])),
        stderr: 'ignore',
      });
    } else {
      const headers = Object.fromEntries(Object.entries(serverConfig.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]));
      const authProvider = serverConfig.oauth === false ? undefined : createAuthProvider(server, serverConfig, configPath, false);
      transport = new StreamableHTTPClientTransport(validateHttpUrl(expandEnv(serverConfig.url), server), {
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
      const available = new Map<string, ToolEntry[]>();
      for (const name of Object.keys(errors)) delete errors[name];
      const discover = async (server: string): Promise<{ tools: ToolEntry[]; rawTools: ToolEntry[]; count: number; bytes: number; fingerprint: string; cached?: boolean; expires?: number } | { error: string }> => {
        const cached = toolCache.get(server);
        if (cached && cached.expires > Date.now()) return { tools: cached.visible, rawTools: cached.tools, count: cached.rawCount, bytes: cached.rawBytes, fingerprint: cached.fingerprint, cached: true, expires: cached.expires };
        const tools: ToolEntry[] = [], rawTools: ToolEntry[] = [];
        let rawCount = 0, bytes = 0;
        try {
          const { client } = await get(server);
          let cursor: string | undefined;
          let pages = 0;
          const seenCursors = new Set<string>();
          const seenNames = new Set<string>();
          do {
            if (++pages > limits.maxPages) throw new Error('page limit exceeded');
            const result = await withTimeout(client.listTools(cursor ? { cursor } : {}, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), REQUEST_TIMEOUT_MS, `Listing tools on ${server} timed out`);
            for (const tool of result.tools) {
              if (++rawCount > limits.maxTools) throw new Error('tool count limit exceeded');
              if (typeof tool.name !== 'string' || tool.name.length === 0 || tool.name.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(tool.name) || seenNames.has(tool.name)) throw new Error('duplicate or invalid tool name');
              seenNames.add(tool.name);
              const entry: ToolEntry = { server, name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema as Record<string, unknown>, ...(tool.annotations ? {annotations:tool.annotations} : {}) };
              const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
              if (size > limits.maxToolBytes) throw new Error('per-tool metadata limit exceeded');
              bytes += size;
              if (bytes > limits.maxCatalogBytes) throw new Error('catalog metadata limit exceeded');
              if (isToolAllowed(config.servers[server], tool.name)) { tools.push(entry); rawTools.push(entry); }
            }
            const nextCursor = result.nextCursor;
            if (nextCursor && seenCursors.has(nextCursor)) throw new Error('repeated pagination cursor');
            if (nextCursor) seenCursors.add(nextCursor);
            cursor = nextCursor;
          } while (cursor);
          return { tools, rawTools, count: rawCount, bytes, fingerprint: createHash('sha256').update(JSON.stringify(tools)).digest('hex') };
        } catch (error) {
          const reason = error instanceof Error && /^(page limit exceeded|tool count limit exceeded|duplicate or invalid tool name|per-tool metadata limit exceeded|catalog metadata limit exceeded|repeated pagination cursor)$/.test(error.message) ? ` Discovery rejected: ${error.message}.` : '';
          return { error: serverConfigError(config.servers[server]) + reason };
        }
      };
      const slots = new Map<number, ReturnType<typeof discover>>();
      for (let i = 0; i < Math.min(4, entries.length); i++) slots.set(i, discover(entries[i]![0]));
      let totalTools = 0, totalBytes = 0;
      for (let i = 0; i < entries.length; i++) {
        const [server] = entries[i]!;
        const result = await slots.get(i)!;
        slots.delete(i);
        if ('error' in result) { errors[server] = result.error; toolCache.delete(server); }
        else if (totalTools + result.count > limits.maxTools || totalBytes + result.bytes > limits.maxCatalogBytes) {
          errors[server] = serverConfigError(config.servers[server]) + ' Discovery rejected: aggregate catalogue limit exceeded.';
          toolCache.delete(server);
        } else {
          totalTools += result.count; totalBytes += result.bytes;
          const previous = snapshotParts.get(server);
          const previousCache = toolCache.get(server);
          const visible = previous && (previous === result.tools || previousCache?.fingerprint === result.fingerprint) ? previous : result.tools;
          const rawTools = result.rawTools;
          toolCache.set(server, { expires: result.cached ? result.expires! : Date.now() + TOOL_CACHE_TTL_MS, tools: rawTools, visible, rawCount: result.count, rawBytes: result.bytes, fingerprint: result.fingerprint });
          available.set(server, visible);
        }
        const following = i + 4;
        if (following < entries.length) slots.set(following, discover(entries[following]![0]));
      }
      const errorState = JSON.stringify(errors);
      let changed = errorState !== snapshotErrors || available.size !== snapshotParts.size;
      if (!changed) for (const [server, tools] of available) {
        if (snapshotParts.get(server) !== tools) { changed = true; break; }
      }
      if (changed || !aggregateSnapshot) {
        snapshotParts = available;
        snapshotErrors = errorState;
        aggregateSnapshot = [...available.values()].flat().sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
      }
      return aggregateSnapshot;
    },
    getErrors(): Record<string, string> { return { ...errors }; },
    async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
      const serverConfig = Object.hasOwn(config.servers, server) ? config.servers[server] : undefined;
      if (!serverConfig || serverConfig.disabled) throw new Error(`Unknown upstream server "${server}"`);
      assertToolAllowed(serverConfig, tool);
      assertCallArguments(args);
      if (signal?.aborted) throw new Error('Tool call cancelled');
      const { client } = await get(server);
      if (signal?.aborted) throw new Error('Tool call cancelled');
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
      toolCache.clear();
      snapshotParts.clear();
      aggregateSnapshot = undefined;
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
