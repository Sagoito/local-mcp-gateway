import { lstat, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const MAX_CONNECTION_FILE_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_QUEUE_MESSAGES = 128;

export interface BridgeConnection {
  url: URL;
  token?: string;
}

export interface BridgeOptions {
  url?: string;
  tokenEnv?: string;
  connectionFile?: string;
  /** Receives a sanitized notification for asynchronous transport failures. */
  onError?: (error: Error) => void;
}

export interface ConnectBridgeOptions extends BridgeOptions {
  stdio?: Transport;
  http?: Transport;
}

/** Resolve and validate the private connection settings used by the bridge. */
export async function validateConnection(
  options: BridgeOptions,
): Promise<BridgeConnection> {
  const hasDirect = options.url !== undefined || options.tokenEnv !== undefined;
  const hasFile = options.connectionFile !== undefined;
  if (hasDirect === hasFile)
    throw new Error(
      'Specify either URL/token environment or a connection file',
    );

  let rawUrl: unknown;
  let token: unknown;
  if (hasFile) {
    let file: Buffer;
    try {
      const metadata = await lstat(options.connectionFile!);
      if (
        !metadata.isFile() ||
        (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
      ) {
        throw new Error('invalid');
      }
      if (metadata.size > MAX_CONNECTION_FILE_BYTES) throw new Error('invalid');
      file = await readFile(options.connectionFile!);
      if (file.byteLength > MAX_CONNECTION_FILE_BYTES)
        throw new Error('invalid');
    } catch {
      throw new Error('Invalid connection file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.toString('utf8'));
    } catch {
      throw new Error('Invalid connection file');
    }
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'token,url,version' ||
      parsed.version !== 1 ||
      typeof parsed.url !== 'string' ||
      typeof parsed.token !== 'string' ||
      !parsed.token.trim()
    ) {
      throw new Error('Invalid connection file');
    }
    rawUrl = parsed.url;
    token = parsed.token;
  } else {
    if (
      typeof options.url !== 'string' ||
      !options.url.trim() ||
      typeof options.tokenEnv !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenEnv)
    ) {
      throw new Error('Specify a URL and valid token environment variable');
    }
    rawUrl = options.url;
    token = process.env[options.tokenEnv];
    if (typeof token !== 'string' || !token.trim())
      throw new Error('Bridge token environment variable is missing');
  }

  if (typeof rawUrl !== 'string') throw new Error('Invalid bridge URL');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid bridge URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid bridge URL');
  }
  return { url, token: token as string };
}

/** Forward JSON-RPC messages between stdio and Streamable HTTP without a second MCP handshake. */
export async function connectBridge(
  options: ConnectBridgeOptions,
): Promise<{ close(): Promise<void> }> {
  let stdio = options.stdio;
  let http = options.http;
  if (!http) {
    const connection = await validateConnection(options);
    http = new StreamableHTTPClientTransport(connection.url, {
      ...(connection.token
        ? {
            requestInit: {
              headers: { Authorization: `Bearer ${connection.token}` },
            },
          }
        : {}),
      redirectPolicy: 'same-origin',
    });
  }
  const ownsStdio = !stdio;
  stdio ??= new StdioServerTransport(undefined, undefined, {
    maxBufferSize: MAX_MESSAGE_BYTES + 128,
  });

  let closed = false;
  let closePromise: Promise<void> | undefined;
  let stdioPending = 0;
  let httpPending = 0;
  let stdioTail = Promise.resolve();
  const initializeIds = new Set<string | number>();
  const genericError = new Error('Bridge transport failed');
  let failureNotified = false;

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    if (ownsStdio) process.stdin.off('end', onStdinEnd);
    closePromise = Promise.resolve()
      .then(() => Promise.allSettled([stdio.close(), http.close()]))
      .then(() => undefined);
    return closePromise;
  };
  const fail = (): void => {
    if (!closed && !failureNotified) {
      failureNotified = true;
      try {
        options.onError?.(genericError);
        if (!options.onError) process.stderr.write('Bridge transport failed\n');
      } catch {
        // Error reporting must not leak transport details or prevent shutdown.
      }
      void close();
    }
  };
  const forward = (
    target: Transport,
    message: JSONRPCMessage,
    direction: 'stdio' | 'http',
  ): void => {
    if (closed) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    } catch {
      fail();
      return;
    }
    const pending = direction === 'stdio' ? stdioPending : httpPending;
    if (bytes > MAX_MESSAGE_BYTES || pending >= MAX_QUEUE_MESSAGES) {
      fail();
      return;
    }
    if (direction === 'stdio') stdioPending++;
    else httpPending++;
    // HTTP sends must be initiated in receive order without serially awaiting their
    // responses: cancellation and notifications can arrive while a request is open.
    const send = async (): Promise<void> => {
      if (!closed) await target.send(message);
    };
    if (direction === 'http') {
      void send()
        .catch(() => fail())
        .finally(() => {
          httpPending--;
        });
    } else {
      stdioTail = stdioTail
        .then(send)
        .catch(() => fail())
        .finally(() => {
          stdioPending--;
        });
    }
  };

  stdio.onmessage = (message) => {
    const raw = message as unknown as Record<string, unknown>;
    if (raw.method === 'initialize' && isValidId(raw.id))
      initializeIds.add(raw.id);
    forward(http, message, 'http');
  };
  http.onmessage = (message) => {
    const raw = message as unknown as Record<string, unknown>;
    if ('result' in raw && isValidId(raw.id) && initializeIds.delete(raw.id)) {
      const result = raw.result;
      if (isRecord(result) && typeof result.protocolVersion === 'string')
        http.setProtocolVersion?.(result.protocolVersion);
    }
    forward(stdio, message, 'stdio');
  };
  stdio.onerror = http.onerror = fail;
  stdio.onclose = http.onclose = () => {
    void close();
  };
  const onStdinEnd = (): void => {
    void close();
  };

  try {
    // Install callbacks before starting either side; start the remote first so it is
    // ready before stdio begins accepting client requests.
    await http.start();
    if (!closed) {
      if (ownsStdio) process.stdin.once('end', onStdinEnd);
      await stdio.start();
    }
  } catch {
    await close();
    throw new Error('Unable to start bridge connection');
  }
  return { close };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string | number {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
