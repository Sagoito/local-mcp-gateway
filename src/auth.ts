import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { expandEnv, validateHttpUrl } from './config.js';
import type { ServerConfig } from './types.js';

type AuthState = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
};
const AUTH_DIR = '.local-mcp-auth';

/** Durable OAuth provider. Secret values and token objects are only ever stored on disk. */
export function createAuthProvider(
  serverName: string,
  serverConfig: ServerConfig,
  configPath: string,
  interactive = false,
): OAuthClientProvider {
  if (!('url' in serverConfig))
    throw new Error(`Server "${serverName}" does not support HTTP OAuth`);
  if (serverConfig.oauth === false)
    throw new Error(`OAuth is disabled for server "${serverName}"`);
  const serverUrl = expandEnv(serverConfig.url);
  validateHttpUrl(serverUrl, serverName);
  const configuredClientId = serverConfig.oauth?.clientId
    ? expandEnv(serverConfig.oauth.clientId)
    : undefined;
  const redirectUrl = 'http://127.0.0.1:43127/callback';
  const file = authFilePath(
    configPath,
    serverName,
    serverUrl,
    configuredClientId,
  );
  const read = async (): Promise<AuthState> => {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as AuthState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Raw filesystem errors can include credential-bearing paths; expose only the sanitized message.
        // eslint-disable-next-line preserve-caught-error -- Raw filesystem errors may expose credentials in the config path.
        throw new Error(`Cannot read OAuth state for "${serverName}"`);
      }
      return {};
    }
  };
  const save = async (next: AuthState): Promise<void> => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await chmod(dirname(file), 0o700).catch(() => undefined);
    const tmp = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  };
  const clientSecret = serverConfig.oauth?.clientSecretEnv
    ? process.env[serverConfig.oauth.clientSecretEnv]
    : undefined;
  if (serverConfig.oauth?.clientSecretEnv && clientSecret === undefined)
    throw new Error(
      `Required environment variable ${serverConfig.oauth.clientSecretEnv} is not set`,
    );
  const clientId = configuredClientId;
  let flowState: string | undefined;
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: redirectUrl ? [redirectUrl] : [],
        token_endpoint_auth_method: clientSecret
          ? 'client_secret_post'
          : 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Local MCP Gateway',
      };
    },
    state: async () => {
      if (flowState) return flowState;
      flowState = randomBytes(32).toString('base64url');
      await save({ ...(await read()), state: flowState });
      return flowState;
    },
    clientInformation: async () => {
      const a = (await read()).client;
      if (a && clientId && a.client_id !== clientId) return undefined;
      if (!a && clientId)
        return {
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        };
      return a;
    },
    saveClientInformation: async (client) => {
      await save({ ...(await read()), client });
    },
    tokens: async () => (await read()).tokens,
    saveTokens: async (tokens) => {
      await save({ ...(await read()), tokens });
    },
    invalidateCredentials: async (scope) => {
      const current = await read();
      if (scope === 'all') {
        await save({});
        return;
      }
      if (scope === 'client') delete current.client;
      if (scope === 'tokens') delete current.tokens;
      if (scope === 'verifier') delete current.verifier;
      await save(current);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- The SDK callback must reject asynchronously on validation failure.
    redirectToAuthorization: async (url) => {
      if (!interactive)
        throw new Error(
          `OAuth login required; run local-mcp login ${serverName}`,
        );
      validateHttpUrl(url.toString(), serverName);
      process.stderr.write(`Authorize ${serverName} at: ${url.toString()}\n`);
      openBrowser(url);
    },
    saveCodeVerifier: async (verifier) => {
      await save({ ...(await read()), verifier });
    },
    codeVerifier: async () => {
      const v = (await read()).verifier;
      if (!v) throw new Error('OAuth verifier is missing');
      return v;
    },
  };
}

/** Run the SDK authorization-code + PKCE flow against one upstream. */
export async function login(
  serverName: string,
  serverConfig: ServerConfig,
  configPath: string,
): Promise<void> {
  if (!('url' in serverConfig))
    throw new Error(`Server "${serverName}" does not support HTTP OAuth`);
  if (serverConfig.oauth === false)
    throw new Error(`OAuth is disabled for server "${serverName}"`);
  serverConfig = {
    ...serverConfig,
    url: expandEnv(serverConfig.url),
    headers: Object.fromEntries(
      Object.entries(serverConfig.headers ?? {}).map(([k, v]) => [
        k,
        expandEnv(v),
      ]),
    ),
    oauth: serverConfig.oauth
      ? {
          ...serverConfig.oauth,
          ...(serverConfig.oauth.clientId
            ? { clientId: expandEnv(serverConfig.oauth.clientId) }
            : {}),
        }
      : undefined,
  };
  const resolvedUrl = validateHttpUrl(serverConfig.url, serverName);
  const provider = createAuthProvider(
    serverName,
    serverConfig,
    configPath,
    true,
  );
  const client = new Client({ name: 'local-mcp-gateway', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(resolvedUrl, {
    authProvider: provider,
    requestInit: { headers: serverConfig.headers },
  });
  const callback = await startCallbackServer(async (url) =>
    Boolean(
      url.searchParams.get('state') &&
      url.searchParams.get('state') === (await provider.state?.()),
    ),
  );
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        // Raw transport errors can include credentials; expose only the sanitized message.
        // eslint-disable-next-line preserve-caught-error -- Raw transport errors can include credentials.
        throw new Error('OAuth authorization could not be started');
      }
      const callbackUrl = await callback.result;
      const gotState = callbackUrl.searchParams.get('state');
      if (!gotState || gotState !== (await provider.state?.())) {
        // eslint-disable-next-line preserve-caught-error -- Callback state errors are sanitized at the auth boundary.
        throw new Error('OAuth callback state did not match');
      }
      const code = callbackUrl.searchParams.get('code');
      if (!code) {
        // eslint-disable-next-line preserve-caught-error -- Callback errors are sanitized at the auth boundary.
        throw new Error('OAuth callback did not contain an authorization code');
      }
      await transport.finishAuth(code);
      await client.connect(transport);
    }
  } finally {
    await transport.close().catch(() => undefined);
    await callback.close();
  }
}

function authFilePath(
  configPath: string,
  serverName: string,
  identity: string,
  clientId?: string,
): string {
  const safeName = serverName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const fingerprint = createHash('sha256')
    .update(
      `${resolve(configPath)}\0${identity}\0${serverName}\0${clientId ?? ''}`,
    )
    .digest('hex')
    .slice(0, 16);
  return join(dirname(configPath), AUTH_DIR, `${safeName}-${fingerprint}.json`);
}

export async function startCallbackServer(
  validateState: (url: URL) => Promise<boolean>,
): Promise<{ result: Promise<URL>; close: () => Promise<void> }> {
  // A stable loopback port keeps the redirect URI registered with the authorization server.
  const server = createServer();
  let resolve!: (url: URL) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<URL>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void result.catch(() => undefined);
  let settled = false;
  const timer = setTimeout(
    () => reject(new Error('Timed out waiting for OAuth callback')),
    5 * 60_000,
  );
  server.on('request', (req, res) => {
    const address = `http://127.0.0.1:43127${req.url ?? '/'}`;
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      res.writeHead(400).end('Invalid authorization response.');
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    void validateState(url)
      .then((valid) => {
        if (settled) {
          res.writeHead(409).end('Authorization response already handled.');
          return;
        }
        if (!valid) {
          res
            .writeHead(400)
            .end(
              'Invalid authorization state. Return to the terminal and try again.',
            );
          return;
        }
        if (!url.searchParams.has('error') && !url.searchParams.get('code')) {
          res.writeHead(400).end('Authorization code is missing.');
          return;
        }
        settled = true;
        if (url.searchParams.has('error')) {
          res
            .writeHead(400)
            .end('Authorization was declined. You can close this window.');
          reject(new Error('OAuth authorization was declined'));
          return;
        }
        res
          .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          .end('Authorization complete. You can close this window.');
        resolve(url);
      })
      .catch(() => {
        res.writeHead(400).end('Invalid authorization response.');
      });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', (error) => {
      clearTimeout(timer);
      rejectListen(error);
    });
    server.listen(43127, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  return {
    result,
    close: () =>
      new Promise((resolveClose) => {
        clearTimeout(timer);
        server.close(() => resolveClose());
      }),
  };
}

function openBrowser(url: URL): void {
  if (process.platform === 'win32') return; // The authorization URL is printed for the user to open.
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    process.stderr.write(
      `Open this URL to authorize the upstream: ${url.toString()}\n`,
    );
  });
  child.unref();
}
