import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { saveConfig } from './config.js';
import { createControlStore, ControlError } from './control-store.js';
import { createServiceRuntime } from './service-runtime.js';
import { createGateway } from './server.js';
import { login } from './auth.js';
import { serviceClientConfig, type ClientFormat } from './client-config.js';
import type { GatewayConfig, ToolEntry } from './types.js';

const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS = 32;
const IDLE_MS = 30 * 60_000;
const randomToken = () => randomBytes(32).toString('base64url');
const json = (
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  });
  res.end(JSON.stringify(value));
};
const safeError = (error: unknown) =>
  error instanceof ControlError
    ? { status: error.status, message: error.message }
    : { status: 500, message: 'Request failed' };
const eqSecret = (provided: string | undefined, expected: string) => {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
const parseCookie = (header: string | undefined, name: string) => {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return undefined;
};

export async function startWebService(options: {
  configPath: string;
  port?: number;
  cliPath: string;
  assetsPath?: string;
}): Promise<{
  origin: string;
  dashboardUrl: string;
  connectionFile: string;
  close(): Promise<void>;
}> {
  const configPath = resolve(options.configPath);
  try {
    await access(configPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await saveConfig(configPath, {
      version: 1,
      servers: {},
      inlineTools: [],
      security: { allowCode: false },
    });
  }
  const runtime = await createServiceRuntime(configPath);
  const store = createControlStore(configPath, async () => {
    await runtime.get();
  });
  const connectionFile = `${configPath}.service.json`;
  const adminToken = randomToken();
  const sessionToken = randomToken();
  const mcpHostToken = await loadOrCreateConnectionToken(connectionFile);
  const sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      gateway: ReturnType<typeof createGateway>;
      last: number;
      active: number;
    }
  >();
  const initializing = new Set<{
    transport: StreamableHTTPServerTransport;
    gateway: ReturnType<typeof createGateway>;
  }>();
  let pendingInitializations = 0;
  type LoginJob = {
    state: 'pending' | 'success' | 'error';
    authorizationUrl?: string;
    error?: string;
    controller?: AbortController;
  };
  const logins = new Map<string, LoginJob>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const assetsPath = resolve(
    options.assetsPath ?? fileURLToPath(new URL('./web/', import.meta.url)),
  );

  const baseHeaders = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  const respondError = (res: ServerResponse, error: unknown) => {
    const e = safeError(error);
    json(res, e.status, { error: e.message }, baseHeaders);
  };
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const type = req.headers['content-type']
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (type !== 'application/json')
      throw new ControlError('Content-Type must be application/json', 415);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > MAX_BODY)
        throw new ControlError('Request body too large', 413);
      chunks.push(Buffer.from(data));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ControlError('Invalid JSON body', 400);
    }
  };
  const stateView = async () => {
    await runtime.get();
    const state = await store.state();
    const status = runtime.status();
    return {
      ...state,
      servers: state.servers.map((s) => {
        const error = status.errors[s.name];
        const state = s.disabled
          ? 'disabled'
          : error
            ? 'error'
            : status.checkedAt === null
              ? 'notchecked'
              : 'ready';
        return {
          ...s,
          state,
          toolCount:
            status.catalog?.filter((t) => t.server === s.name).length ?? 0,
          ...(error ? { error } : {}),
        };
      }),
      checkedAt: status.checkedAt,
      errors: status.errors,
    };
  };
  const getAdmin = (req: IncomingMessage) => {
    const auth = req.headers.authorization;
    const bearer =
      typeof auth === 'string' && auth.startsWith('Bearer ')
        ? auth.slice(7)
        : undefined;
    if (eqSecret(bearer, adminToken)) return true;
    return (
      req.headers['x-weftly-request'] === '1' &&
      eqSecret(parseCookie(req.headers.cookie, 'weftly_session'), sessionToken)
    );
  };
  const makeSession = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ) => {
    if (!isInitializeRequest(body)) {
      json(
        res,
        400,
        { error: 'A valid MCP initialize request is required' },
        baseHeaders,
      );
      return;
    }
    if (sessions.size + pendingInitializations >= MAX_SESSIONS) {
      json(res, 503, { error: 'MCP session limit reached' }, baseHeaders);
      return;
    }
    pendingInitializations++;
    let resource:
      | {
          transport: StreamableHTTPServerTransport;
          gateway: ReturnType<typeof createGateway>;
        }
      | undefined;
    let initialized = false;
    try {
      const initial = await runtime.get();
      const initialCatalog = runtime.status().catalog ?? [];
      const gateway = createGateway(
        initial,
        () => runtime.get(),
        initialCatalog,
        (tools) => selectInline(runtime.config(), tools),
        (tools) => selectNative(runtime.config(), tools),
        () => runtime.config().security,
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomToken,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, gateway, last: Date.now(), active: 0 });
        },
      });
      const onclose = gateway.onclose;
      resource = { transport, gateway };
      initializing.add(resource);
      gateway.onclose = () => {
        onclose?.();
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      await gateway.connect(transport);
      if (closing) throw new Error('Service is closing');
      await transport.handleRequest(req, res, body);
      initialized = true;
    } finally {
      pendingInitializations--;
      if (resource) {
        initializing.delete(resource);
        if (
          !initialized ||
          closing ||
          !resource.transport.sessionId ||
          !sessions.has(resource.transport.sessionId)
        ) {
          await resource.gateway.close().catch(() => undefined);
        }
      }
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (closing) {
        json(res, 503, { error: 'Service is closing' }, baseHeaders);
        return;
      }
      res.setHeader(
        'Content-Security-Policy',
        baseHeaders['Content-Security-Policy'],
      );
      res.setHeader(
        'X-Content-Type-Options',
        baseHeaders['X-Content-Type-Options'],
      );
      res.setHeader('Referrer-Policy', baseHeaders['Referrer-Policy']);
      res.setHeader('Cache-Control', baseHeaders['Cache-Control']);
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const host = req.headers.host;
      if (
        host !== new URL(origin).host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin)
      ) {
        json(res, 403, { error: 'Forbidden' }, baseHeaders);
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? '/', origin);
      } catch {
        json(res, 400, { error: 'Invalid URL' }, baseHeaders);
        return;
      }
      let decodedPath: string;
      try {
        decodedPath = decodeURI(url.pathname);
      } catch {
        json(res, 400, { error: 'Invalid URL' }, baseHeaders);
        return;
      }
      if (
        !req.url?.startsWith('/') ||
        req.url.startsWith('//') ||
        url.origin !== origin ||
        url.pathname.includes('..') ||
        decodedPath !== url.pathname
      ) {
        json(res, 403, { error: 'Forbidden' }, baseHeaders);
        return;
      }
      const path = url.pathname;
      if (path === '/mcp') {
        const bearer = req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : undefined;
        if (!eqSecret(bearer, mcpHostToken)) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          json(res, 401, { error: 'Unauthorized' }, baseHeaders);
          return;
        }
        if (req.method === 'POST') {
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (e) {
            respondError(res, e);
            return;
          }
          const id = req.headers['mcp-session-id'];
          if (typeof id === 'string') {
            const session = sessions.get(id);
            if (!session) {
              json(res, 404, { error: 'Unknown MCP session' }, baseHeaders);
              return;
            }
            session.active++;
            session.last = Date.now();
            try {
              await session.transport.handleRequest(req, res, body);
            } finally {
              session.active--;
              session.last = Date.now();
            }
          } else await makeSession(req, res, body);
          return;
        }
        const id = req.headers['mcp-session-id'];
        if (typeof id !== 'string' || !sessions.has(id)) {
          json(
            res,
            id ? 404 : 400,
            { error: id ? 'Unknown MCP session' : 'MCP session required' },
            baseHeaders,
          );
          return;
        }
        const session = sessions.get(id)!;
        // A passive SSE listener must not keep an unused session alive forever.
        const activeRequest = req.method !== 'GET';
        if (activeRequest) session.active++;
        session.last = Date.now();
        try {
          await session.transport.handleRequest(req, res);
        } finally {
          if (activeRequest) session.active--;
          session.last = Date.now();
        }
        return;
      }
      if (path.startsWith('/api/')) {
        const adminOnly = !(path === '/api/session' && req.method === 'POST');
        if (adminOnly && !getAdmin(req)) {
          json(res, 401, { error: 'Unauthorized' }, baseHeaders);
          return;
        }
        if (path === '/api/session' && req.method === 'POST') {
          const auth = req.headers.authorization;
          if (!(
            typeof auth === 'string' &&
            auth.startsWith('Bearer ') &&
            eqSecret(auth.slice(7), adminToken)
          )) {
            json(res, 401, { error: 'Unauthorized' }, baseHeaders);
            return;
          }
          json(
            res,
            200,
            { ok: true },
            {
              ...baseHeaders,
              'Set-Cookie': `weftly_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400`,
            },
          );
          return;
        }
        if (path === '/api/state' && req.method === 'GET') {
          json(res, 200, await stateView(), baseHeaders);
          return;
        }
        if (path === '/api/servers' && req.method === 'POST') {
          json(res, 200, await store.upsert(await readBody(req)), baseHeaders);
          return;
        }
        const remove = /^\/api\/servers\/([^/]+)$/.exec(path);
        if (remove && req.method === 'DELETE') {
          json(
            res,
            200,
            await store.remove(
              decodeURIComponent(remove[1]),
              await readBody(req),
            ),
            baseHeaders,
          );
          return;
        }
        if (path === '/api/policy' && req.method === 'POST') {
          json(res, 200, await store.policy(await readBody(req)), baseHeaders);
          return;
        }
        if (path === '/api/import' && req.method === 'POST') {
          json(res, 200, await store.import(await readBody(req)), baseHeaders);
          return;
        }
        if (path === '/api/refresh' && req.method === 'POST') {
          await readBody(req);
          await runtime.refresh();
          json(res, 200, await stateView(), baseHeaders);
          return;
        }
        const loginRoute = /^\/api\/login\/([^/]+)$/.exec(path);
        if (loginRoute && req.method === 'POST') {
          await readBody(req);
          await runtime.get();
          const name = decodeURIComponent(loginRoute[1]);
          const cfg = runtime.config().servers[name];
          if (!cfg || !('url' in cfg) || cfg.disabled || cfg.oauth === false)
            throw new ControlError(
              'OAuth login is unavailable for this server',
              400,
            );
          if (logins.get(name)?.state === 'pending') {
            json(
              res,
              202,
              {
                name,
                state: 'pending',
                authorizationUrl: logins.get(name)?.authorizationUrl,
              },
              baseHeaders,
            );
            return;
          }
          if ([...logins.values()].some((job) => job.state === 'pending'))
            throw new ControlError(
              'Another sign-in is already in progress',
              409,
            );
          const controller = new AbortController();
          const job: LoginJob = { state: 'pending', controller };
          logins.set(name, job);
          void login(name, cfg, configPath, {
            signal: controller.signal,
            onAuthorize: (authorizationUrl) => {
              job.authorizationUrl = authorizationUrl.toString();
            },
          })
            .then(async () => {
              await runtime.refresh();
              job.state = 'success';
              delete job.authorizationUrl;
              delete job.controller;
            })
            .catch(() => {
              job.state = 'error';
              job.error =
                'OAuth sign-in failed. Check the server settings and try again.';
              delete job.authorizationUrl;
              delete job.controller;
            });
          json(res, 202, { name, state: 'pending' }, baseHeaders);
          return;
        }
        if (path === '/api/logins' && req.method === 'GET') {
          json(
            res,
            200,
            [...logins].map(([name, j]) => ({
              name,
              state: j.state,
              ...(j.authorizationUrl
                ? { authorizationUrl: j.authorizationUrl }
                : {}),
              ...(j.error ? { error: j.error } : {}),
            })),
            baseHeaders,
          );
          return;
        }
        if (path === '/api/connection' && req.method === 'GET') {
          const client = (url.searchParams.get('client') ??
            'generic') as ClientFormat;
          if (!['generic', 'copilot', 'vscode', 'opencode'].includes(client))
            throw new ControlError('Unsupported client format', 400);
          json(
            res,
            200,
            {
              endpoint: `${origin}/mcp`,
              connectionFile,
              entry: serviceClientConfig(client, {
                connectionFile,
                cliPath: options.cliPath,
              }),
            },
            baseHeaders,
          );
          return;
        }
        throw new ControlError('Not found', 404);
      }
      if (req.method !== 'GET') {
        json(res, 404, { error: 'Not found' }, baseHeaders);
        return;
      }
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!['index.html', 'app.js', 'style.css', 'logo.svg'].includes(file)) {
        json(res, 404, { error: 'Not found' }, baseHeaders);
        return;
      }
      try {
        const data = await readFile(join(assetsPath, file));
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Type': file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : file.endsWith('.svg')
                ? 'image/svg+xml'
                : 'text/html; charset=utf-8',
        });
        res.end(data);
      } catch {
        json(res, 404, { error: 'Not found' }, baseHeaders);
      }
    })().catch((error) => {
      if (!res.headersSent) respondError(res, error);
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 64;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 43821, '127.0.0.1', () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await updateConnectionFile(connectionFile, `${origin}/mcp`, mcpHostToken);
  } catch (error) {
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.close();
    throw error;
  }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions)
      if (!s.active && now - s.last > IDLE_MS) {
        sessions.delete(id);
        void s.gateway.close().catch(() => undefined);
      }
  }, 60_000);
  timer.unref();
  return {
    origin,
    dashboardUrl: `${origin}/#token=${adminToken}`,
    connectionFile,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        clearInterval(timer);
        for (const j of logins.values()) j.controller?.abort();
        await Promise.all(
          [...sessions.values(), ...initializing].map(async (s) => {
            await s.transport.close().catch(() => undefined);
            await s.gateway.close().catch(() => undefined);
          }),
        );
        sessions.clear();
        initializing.clear();
        const stopped = new Promise<void>((r) => server.close(() => r()));
        server.closeAllConnections();
        await stopped;
        await runtime.close();
      })();
      return closePromise;
    },
  };
}

async function loadOrCreateConnectionToken(file: string): Promise<string> {
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink() || !st.isFile())
      throw new Error('Unsafe service connection file');
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
      throw new Error('Service connection file permissions are too broad');
    if (st.size > 64 * 1024) throw new Error('Invalid service connection file');
    const data = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(',') !== 'token,url,version' ||
      data.version !== 1 ||
      typeof data.url !== 'string' ||
      typeof data.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.token)
    )
      throw new Error('Invalid service connection file');
    return data.token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return randomToken();
  }
}
async function updateConnectionFile(file: string, url: string, token: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, url, token }), {
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
function selectInline(config: GatewayConfig, tools: ToolEntry[]) {
  return config.inlineTools === undefined
    ? config.nativeTools?.length
      ? []
      : tools
    : tools.filter((t) =>
        config.inlineTools!.some(
          (x) => x.server === t.server && x.tool === t.name,
        ),
      );
}
function selectNative(config: GatewayConfig, tools: ToolEntry[]) {
  return (config.nativeTools ?? []).flatMap((x) =>
    tools.filter((t) => x.server === t.server && x.tool === t.name),
  );
}
