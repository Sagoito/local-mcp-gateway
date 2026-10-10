import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import type { GatewayConfig, ServerConfig } from './types.js';

export function defaultConfigPath(): string {
  return process.env.LOCAL_MCP_CONFIG || `${homedir()}/.config/local-mcp/config.json`;
}

/** Expand ${NAME} references without including environment values in errors. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const result = process.env[name];
    if (result === undefined) throw new Error(`Required environment variable ${name} is not set`);
    return result;
  });
}

function validServerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== '__proto__' && name !== 'constructor' && name !== 'prototype';
}

function validateConfig(input: unknown): GatewayConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be a JSON object');
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1 || !obj.servers || typeof obj.servers !== 'object' || Array.isArray(obj.servers)) {
    throw new Error('Config must have version 1 and a servers object');
  }
  const servers: Record<string, ServerConfig> = Object.create(null) as Record<string, ServerConfig>;
  for (const [name, raw] of Object.entries(obj.servers as Record<string, unknown>)) {
    if (!validServerName(name)) throw new Error(`Invalid server name: ${name}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid configuration for server ${name}`);
    const entry = raw as Record<string, unknown>;
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') throw new Error(`Invalid disabled setting for server ${name}`);
    if (typeof entry.command === 'string' && entry.command.length > 0) {
      if (entry.url !== undefined) throw new Error(`Server ${name} cannot specify both command and url`);
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(x => typeof x !== 'string'))) throw new Error(`Invalid args for server ${name}`);
      if (entry.env !== undefined && (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env) || Object.values(entry.env).some(x => typeof x !== 'string'))) throw new Error(`Invalid env for server ${name}`);
      servers[name] = { command: entry.command, ...(entry.args ? { args: [...entry.args as string[]] } : {}), ...(entry.env ? { env: { ...entry.env as Record<string,string> } } : {}), ...(entry.disabled === true ? { disabled: true } : {}) };
    } else if (typeof entry.url === 'string') {
      if (entry.command !== undefined) throw new Error(`Server ${name} cannot specify both command and url`);
      const urlText = entry.url.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'placeholder');
      let url: URL;
      try { url = new URL(urlText); } catch { throw new Error(`Invalid URL for server ${name}`); }
      if (url.username || url.password) throw new Error(`URL for server ${name} must not contain user information`);
      const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`Server ${name} URL must use HTTPS, or HTTP on loopback`);
      if (entry.headers !== undefined && (!entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers) || Object.values(entry.headers).some(x => typeof x !== 'string'))) throw new Error(`Invalid headers for server ${name}`);
      let oauth: { clientId?: string; clientSecretEnv?: string } | undefined;
      if (entry.oauth !== undefined) {
        if (!entry.oauth || typeof entry.oauth !== 'object' || Array.isArray(entry.oauth)) throw new Error(`Invalid OAuth config for server ${name}`);
        const o = entry.oauth as Record<string, unknown>;
        if (o.clientId !== undefined && typeof o.clientId !== 'string') throw new Error(`Invalid OAuth client ID for server ${name}`);
        if (o.clientSecretEnv !== undefined && typeof o.clientSecretEnv !== 'string') throw new Error(`Invalid OAuth secret environment name for server ${name}`);
        oauth = { ...(typeof o.clientId === 'string' && o.clientId ? { clientId: o.clientId } : {}), ...(typeof o.clientSecretEnv === 'string' && o.clientSecretEnv ? { clientSecretEnv: o.clientSecretEnv } : {}) };
      }
      servers[name] = { url: entry.url, ...(entry.headers ? { headers: { ...entry.headers as Record<string,string> } } : {}), ...(oauth ? { oauth } : {}), ...(entry.disabled === true ? { disabled: true } : {}) };
    } else throw new Error(`Server ${name} must specify command or url`);
  }
  const validateToolEntries = (value: unknown, selectorName: 'inlineTools' | 'nativeTools'): Array<{ server: string; tool: string }> => {
    if (!Array.isArray(value) || value.length > 5) throw new Error(`${selectorName} must be an array with at most 5 entries`);
    const seen = new Set<string>();
    return value.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid ${selectorName} entry at index ${index}`);
      const entry = raw as Record<string, unknown>;
      if (Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'server') || !Object.hasOwn(entry, 'tool')) throw new Error(`Invalid ${selectorName} entry at index ${index}`);
      if (typeof entry.server !== 'string' || !validServerName(entry.server)) throw new Error(`Invalid server name in ${selectorName} entry at index ${index}`);
      if (!Object.hasOwn(servers, entry.server)) throw new Error(`Unknown ${selectorName} server: ${entry.server}`);
      if (typeof entry.tool !== 'string' || entry.tool.length === 0 || entry.tool.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(entry.tool)) throw new Error(`Invalid tool name in ${selectorName} entry at index ${index}`);
      const entryKey = JSON.stringify([entry.server, entry.tool]);
      if (seen.has(entryKey)) throw new Error(`Duplicate ${selectorName} entry: ${entry.server}/${entry.tool}`);
      seen.add(entryKey);
      return { server: entry.server, tool: entry.tool };
    });
  };
  const inlineTools = obj.inlineTools !== undefined ? validateToolEntries(obj.inlineTools, 'inlineTools') : undefined;
  const nativeTools = obj.nativeTools !== undefined ? validateToolEntries(obj.nativeTools, 'nativeTools') : undefined;
  return { version: 1, servers, ...(inlineTools !== undefined ? { inlineTools } : {}), ...(nativeTools !== undefined ? { nativeTools } : {}) };
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} };
    throw new Error(`Cannot read config file ${path}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(`Config file ${path} contains invalid JSON`); }
  return validateConfig(parsed);
}

export async function saveConfig(path: string, config: GatewayConfig): Promise<void> {
  const normalized = validateConfig(config);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
