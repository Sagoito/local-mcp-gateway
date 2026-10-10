import type { ServerConfig } from './types.js';

export const LIMIT_DEFAULTS = Object.freeze({
  maxTools: 5000,
  maxCatalogBytes: 32 * 1024 * 1024,
  maxToolBytes: 256 * 1024,
  maxPages: 100,
});

/** An omitted allowlist preserves the historical unrestricted behavior. */
export function isToolAllowed(
  serverConfig: ServerConfig | undefined,
  toolName: string,
): boolean {
  return (
    serverConfig !== undefined &&
    serverConfig.disabled !== true &&
    (serverConfig.allowedTools === undefined ||
      serverConfig.allowedTools.includes(toolName))
  );
}

export function assertToolAllowed(
  serverConfig: ServerConfig | undefined,
  toolName: string,
): void {
  if (!isToolAllowed(serverConfig, toolName))
    throw new Error('Tool is not allowed by server policy');
}

/** Validate a call payload and enforce the UTF-8 byte limit used for arguments. */
export function assertCallArguments(
  args: unknown,
  maxBytes = 64 * 1024,
): asserts args is Record<string, unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('Invalid tool argument size limit');
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Tool arguments must be a JSON object');
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw new Error('Tool arguments must be JSON-serializable');
  }
  if (serialized === undefined)
    throw new Error('Tool arguments must be JSON-serializable');
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes)
    throw new Error('Tool arguments exceed the size limit');
}
