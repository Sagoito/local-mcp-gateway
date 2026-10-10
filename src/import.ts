import { resolve } from 'node:path';
import { validateConfig } from './config.js';
import type { ServerConfig } from './types.js';

export type ImportFormat = 'auto' | 'mcpServers' | 'vscode' | 'opencode';
export interface ImportIssue { server: string; message: string }
export interface ImportResult { servers: Record<string, ServerConfig>; issues: ImportIssue[]; notices: string[]; format: string }

// Strip JSONC comments and trailing commas with a state machine. String contents,
// including escaped quotes and comment-looking text, are copied byte-for-byte.
function parseJsonc(text: string): unknown {
  text = text.replace(/^\uFEFF/, '');
  let out = '', inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inString) { out += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } out += '\n'; continue; }
    if (c === '/' && n === '*') { out += '  '; i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; } if (i >= text.length) throw new Error('Malformed JSONC input'); out += '  '; i++; continue; }
    out += c;
  }
  if (inString) throw new Error('Malformed JSONC input');
  let json = '', quoted = false; escaped = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quoted) { json += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; json += c; continue; }
    if (c === ',') {
      let j = i + 1; while (/\s/.test(out[j] ?? '')) j++;
      let k = i - 1; while (k >= 0 && /\s/.test(out[k])) k--;
      if ((out[j] === '}' || out[j] === ']') && k >= 0 && !['{','[',':',','].includes(out[k])) continue;
    }
    json += c;
  }
  out = json;
  let parsed: unknown;
  try { parsed = JSON.parse(out); } catch { throw new Error('Malformed JSONC input'); }
  // JSON.parse silently keeps the last duplicate. Scan validated JSON tokens so
  // duplicate keys (including escaped-equivalent spellings) fail closed.
  const stack: Array<{ kind: '{' | '['; keys?: Set<string> }> = [];
  for (let i = 0; i < out.length;) {
    const c = out[i];
    if (c === '"') {
      const start = i++;
      let escaped = false;
      while (i < out.length) { const ch = out[i++]; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') break; }
      let j = i; while (/\s/.test(out[j] ?? '')) j++;
      if (out[j] === ':' && stack.at(-1)?.kind === '{') {
        const key = JSON.parse(out.slice(start, i)) as string;
        const keys = stack.at(-1)!.keys!;
        if (keys.has(key)) throw new Error('Duplicate object key');
        keys.add(key);
      }
      continue;
    }
    if (c === '{') stack.push({ kind: '{', keys: new Set() });
    else if (c === '[') stack.push({ kind: '[' });
    else if (c === '}' || c === ']') stack.pop();
    i++;
  }
  return parsed;
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function ownKeysOnly(o: Record<string, unknown>, allowed: string[], name: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error('Unsupported server setting');
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') throw new Error('Unsafe server name');
}
function translateValue(s: string, format: string, workspaceDir: string, allowBareEnv = false): string {
  // Supported source spellings all become the gateway's runtime ${NAME} form.
  s = s.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}').replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
  s = s.replace(/\$\{workspaceFolder\}/g, workspaceDir);
  if (allowBareEnv) s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, '${$1}');
  const refs = [...s.matchAll(/\$\{([^}]*)\}/g)];
  for (const ref of refs) {
    const name = ref[1];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^GITHUB_COPILOT_OIDC_MCP_TOKEN(?:_|$)/.test(name)) throw new Error('Unsupported variable reference; use a named environment variable or supported workspaceFolder reference');
  }
  if (s.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').includes('${')) throw new Error('Unsupported variable reference');
  if (/\{(?:file:|input:|env:|config:)|\$[A-Za-z_][A-Za-z0-9_]*:-/.test(s)) throw new Error('Unsupported variable reference; use a named environment variable or supported workspaceFolder reference');
  if (allowBareEnv && /\$[^\{A-Za-z_]/.test(s)) throw new Error('Unsupported environment variable syntax');
  return s;
}
function strings(v: unknown, what: string): string[] { if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`Invalid ${what}`); return v as string[]; }
function envMap(v: unknown): Record<string,string> | undefined {
  if (v === undefined) return undefined;
  if (!obj(v)) throw new Error('Invalid environment map');
  const out: Record<string,string> = Object.create(null);
  for (const [k,x] of Object.entries(v)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof x !== 'string') throw new Error('Invalid environment map'); out[k] = x; }
  return out;
}

export function importClientConfig(text: string, options: { format?: ImportFormat; workspaceDir: string; names?: string[] }): ImportResult {
  const issues: ImportIssue[] = [], notices: string[] = [], servers: Record<string,ServerConfig> = Object.create(null);
  let root: unknown;
  try { root = parseJsonc(text); } catch { return { servers, issues: [{ server: '(config)', message: 'Malformed JSONC input' }], notices, format: 'unknown' }; }
  if (!obj(root)) return { servers, issues: [{ server: '(config)', message: 'Configuration root must be an object' }], notices, format: 'unknown' };
  let format = options.format ?? 'auto';
  if (format === 'auto') {
    const candidates = ['mcpServers', 'servers', 'mcp'].filter(k => Object.hasOwn(root!, k));
    if (candidates.length !== 1) return { servers, issues: [{ server: '(config)', message: candidates.length ? 'Ambiguous server configuration roots' : 'No supported server configuration root found' }], notices, format: 'unknown' };
    format = candidates[0] === 'mcpServers' ? 'mcpServers' : candidates[0] === 'servers' ? 'vscode' : 'opencode';
  }
  if (!['mcpServers','vscode','opencode'].includes(format)) return { servers, issues: [{ server: '(config)', message: 'Unsupported import format' }], notices, format: 'unknown' };
  const rootObj = root as Record<string,unknown>;
  const mapKey = format === 'mcpServers' ? 'mcpServers' : format === 'vscode' ? 'servers' : 'mcp';
  const mapping = rootObj[mapKey];
  if (!obj(mapping)) return { servers, issues: [{ server: '(config)', message: `Expected a "${mapKey}" object` }], notices, format };
  if (['tools','permission','permissions','agent','mode','sandbox'].some(k => Object.hasOwn(rootObj,k))) issues.push({ server: '(config)', message: 'Root permissions and tool policies cannot be preserved' });
  if (['client','global','enterprise'].some(k => Object.hasOwn(rootObj,k))) issues.push({ server: '(config)', message: 'Client or enterprise policy settings cannot be preserved' });
  notices.push('Import reads this file only; client approvals, inherited configurations, OS sandboxing and enterprise policies do not transfer. Review them before switching.');
  const requested = options.names === undefined ? Object.keys(mapping) : options.names;
  for (const name of requested) {
    if (!Object.hasOwn(mapping, name)) { issues.push({ server: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : '<invalid-name>', message: 'Requested server name was not found' }); continue; }
    try {
      const entry = mapping[name]; if (!obj(entry)) throw new Error('Server entry must be an object');
      const result = convert(name, entry, format, options.workspaceDir, notices);
      // Validate through the gateway's canonical config validation path.
      const validated = validateConfig({ version: 1, servers: { [name]: result } });
      if (!Object.hasOwn(validated.servers, name)) throw new Error('Invalid server configuration');
      servers[name] = validated.servers[name];
    } catch (e) { issues.push({ server: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : '<invalid-name>', message: e instanceof Error ? e.message : 'Invalid server configuration' }); }
  }
  return { servers, issues, notices: [...new Set(notices)], format };
}

function convert(name: string, e: Record<string,unknown>, format: string, workspaceDir: string, notices: string[]): ServerConfig {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || ['__proto__','constructor','prototype'].includes(name)) throw new Error('Invalid server name');
  const ignored = ['description','deferTools','slowConnectionThresholdMs'];
  if (e.description !== undefined && typeof e.description !== 'string') throw new Error('Invalid description');
  if (e.deferTools !== undefined && !['auto','never'].includes(String(e.deferTools))) throw new Error('Invalid deferTools setting');
  if (e.slowConnectionThresholdMs !== undefined && (!Number.isSafeInteger(e.slowConnectionThresholdMs) || (e.slowConnectionThresholdMs as number) < 1)) throw new Error('Invalid connection warning threshold');
  for (const k of ignored) if (Object.hasOwn(e,k)) notices.push(`Server ${name}: ignored ${k}.`);
  if (Object.hasOwn(e,'timeout')) throw new Error('Unsupported timeout setting');
  if (Object.hasOwn(e,'filterMapping')) throw new Error('Unsupported filterMapping setting');
  if (format === 'mcpServers' && e.disableToolCache !== undefined) {
    if (typeof e.disableToolCache !== 'boolean') throw new Error('Invalid disableToolCache setting');
    notices.push(`Server ${name}: ignored disableToolCache; cache policy cannot be preserved.`);
  }
  if (format === 'vscode' && e.sandboxEnabled !== undefined) {
    if (e.sandboxEnabled === true) throw new Error('VS Code sandboxEnabled cannot be preserved');
    if (e.sandboxEnabled !== false) throw new Error('Invalid sandboxEnabled setting');
    notices.push(`Server ${name}: ignored sandboxEnabled=false.`);
  }
  let allowedTools: string[] | undefined;
  const filter = e.tools;
  if (filter !== undefined) {
    const names = strings(filter, 'tool filter');
    if (names.includes('*')) { if (names.length !== 1) throw new Error('Wildcard tool filter cannot be combined with names'); }
    else { if (names.some(x => /[*?\[\]]/.test(x))) throw new Error('Wildcard tool filters cannot be represented'); allowedTools = names; }
  }
  if (e.enabled !== undefined && typeof e.enabled !== 'boolean') throw new Error('Invalid enabled setting');
  if (e.disabled !== undefined && typeof e.disabled !== 'boolean') throw new Error('Invalid disabled setting');
  if (e.enabled !== undefined && e.disabled !== undefined && e.enabled !== !e.disabled) throw new Error('Conflicting enabled and disabled settings');
  const disabled = e.enabled === false || e.disabled === true;
  const allowedByFormat: Record<string,string[]> = {
    mcpServers: ['type','command','args','env','url','headers','disabled','enabled','tools','description','deferTools','slowConnectionThresholdMs','cwd','oauth','oauthClientId','oauthScopes','oauthPublicClient','oauthGrantType','disableToolCache','timeout','filterMapping'],
    vscode: ['type','command','args','env','url','headers','disabled','enabled','tools','description','deferTools','slowConnectionThresholdMs','cwd','sandboxEnabled','timeout','filterMapping'],
    opencode: ['type','command','args','environment','env','url','headers','disabled','enabled','tools','description','deferTools','slowConnectionThresholdMs','cwd','oauth','oauthClientId','oauthScopes','oauthPublicClient','oauthGrantType','timeout','filterMapping']
  };
  ownKeysOnly(e, allowedByFormat[format] ?? [], name);
  if (format === 'opencode' && e.disableToolCache !== undefined) throw new Error('Unsupported server setting');
  if (format !== 'opencode' && e.environment !== undefined) throw new Error('Unsupported server setting');
  if (e.oauthScopes !== undefined) throw new Error('Unsupported OAuth scopes setting');
  if (e.oauthPublicClient !== undefined && e.oauthPublicClient !== true) throw new Error('Unsupported OAuth public client setting');
  if (e.oauthGrantType !== undefined && e.oauthGrantType !== 'authorization_code') throw new Error('Unsupported OAuth grant type');
  if (e.oauthGrantType !== undefined || e.oauthPublicClient !== undefined) notices.push(`Server ${name}: accepted OAuth compatibility setting.`);
  const type = e.type;
  const localTypes = format === 'opencode' ? ['local'] : format === 'mcpServers' ? ['local','stdio'] : ['stdio'];
  const remoteTypes = format === 'opencode' ? ['remote'] : ['http','streamable-http'];
  if (type === 'sse') throw new Error('SSE transport is unsupported');
  if (type !== undefined && ![...localTypes,...remoteTypes].includes(String(type))) throw new Error('Unsupported transport type');
  if (e.command !== undefined && e.url !== undefined) throw new Error('Server cannot specify both command and url');
  const local = type === undefined ? e.command !== undefined : localTypes.includes(String(type));
  const remote = type === undefined ? e.url !== undefined : remoteTypes.includes(String(type));
  if (local) {
    if (e.url !== undefined) throw new Error('Local transport cannot specify url');
    if (e.headers !== undefined || e.oauth !== undefined || e.oauthClientId !== undefined || e.oauthScopes !== undefined || e.oauthPublicClient !== undefined || e.oauthGrantType !== undefined) throw new Error('HTTP-only settings are not valid for stdio servers');
    if (format === 'opencode' && !Array.isArray(e.command)) throw new Error('OpenCode local command must be an array');
    if (format !== 'opencode' && Array.isArray(e.command)) throw new Error('Command must be a string in this format');
    if (format === 'opencode' && e.args !== undefined) throw new Error('OpenCode arguments must be part of the command array');
    const cmd = Array.isArray(e.command) ? e.command : undefined;
    if (cmd && cmd.some(v => typeof v !== 'string')) throw new Error('Invalid command');
    const command = cmd ? cmd[0] : e.command;
    if (typeof command !== 'string' || !command) throw new Error('Invalid command');
    const cv = (v: string) => translateValue(v, format, workspaceDir);
    if (format === 'opencode' && e.environment !== undefined && e.env !== undefined) throw new Error('Conflicting environment settings');
    const args = cmd ? cmd.slice(1).map(cv) : strings(e.args ?? [], 'arguments').map(cv);
    const env = envMap(format === 'opencode' ? e.environment ?? e.env : e.env);
    const cwd = e.cwd;
    if (cwd !== undefined && typeof cwd !== 'string') throw new Error('Invalid working directory');
    const translatedCwd = typeof cwd === 'string' ? cv(cwd) : undefined;
    if (translatedCwd?.includes('${')) throw new Error('Environment references in cwd cannot be resolved safely; use an absolute working directory');
    const resolvedCwd = translatedCwd !== undefined ? resolve(workspaceDir, translatedCwd) : workspaceDir;
    const convertedEnv: Record<string,string> | undefined = env && Object.fromEntries(Object.entries(env).map(([k,v]) => [k, translateValue(v, format, workspaceDir, format === 'mcpServers')]));
    return { command: cv(command), ...(args.length ? { args } : {}), ...(convertedEnv ? { env: convertedEnv } : {}), cwd: resolvedCwd, ...(disabled ? { disabled: true } : {}), ...(allowedTools ? { allowedTools } : {}) } as ServerConfig;
  }
  if (remote) {
    if (e.command !== undefined || e.args !== undefined || e.env !== undefined || e.environment !== undefined || e.cwd !== undefined) throw new Error('Stdio-only settings are not valid for HTTP servers');
    if (typeof e.url !== 'string') throw new Error('HTTP server url is required');
    let safeHeaders: Record<string,string> | undefined;
    if (e.headers !== undefined) { if (!obj(e.headers) || Object.values(e.headers).some(v => typeof v !== 'string')) throw new Error('Invalid headers'); const headers: Record<string,string> = Object.create(null); for (const [k,v] of Object.entries(e.headers)) headers[k] = translateValue(v as string, format, workspaceDir, format === 'mcpServers'); safeHeaders = headers; }
    let oauth: {clientId?:string;clientSecretEnv?:string} | undefined;
    if (format === 'opencode' || format === 'mcpServers') {
      const raw = obj(e.oauth) ? e.oauth : Object.create(null) as Record<string,unknown>;
      if (e.oauth !== undefined && e.oauth !== false && !obj(e.oauth)) throw new Error('Invalid OAuth configuration');
      if (e.oauth === false) {
        if (e.oauthClientId !== undefined || e.oauthGrantType !== undefined || e.oauthPublicClient !== undefined) throw new Error('OAuth is disabled but OAuth settings were provided');
        return { url: translateValue(e.url, format, workspaceDir), oauth: false, ...(safeHeaders ? { headers: safeHeaders } : {}), ...(disabled ? { disabled: true } : {}), ...(allowedTools !== undefined ? { allowedTools } : {}) };
      }
      for (const k of Object.keys(raw)) if (!['clientId','clientSecret','scope','scopes'].includes(k)) throw new Error('Unsupported OAuth setting');
      if (raw.scope !== undefined || raw.scopes !== undefined) throw new Error('Unsupported OAuth scopes setting');
      let clientSecretEnv: string | undefined;
      if (raw.clientSecret !== undefined) {
        if (typeof raw.clientSecret !== 'string') throw new Error('Invalid OAuth client secret reference');
        const m = raw.clientSecret.match(/^(?:\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\})$/);
        if (!m) throw new Error('Literal OAuth client secrets cannot be imported; use an environment variable reference');
        clientSecretEnv = m[1] || m[2] || m[3];
        if (/^GITHUB_COPILOT_OIDC_MCP_TOKEN(?:_|$)/.test(clientSecretEnv)) throw new Error('Agent-managed OIDC credentials cannot be imported');
      }
      if (e.oauthClientId !== undefined && raw.clientId !== undefined) throw new Error('Conflicting OAuth client ID settings');
      const clientId = e.oauthClientId ?? raw.clientId;
      if (clientId !== undefined && typeof clientId !== 'string') throw new Error('Invalid OAuth client ID');
      if (raw.clientSecret !== undefined || clientId) oauth = { ...(clientId ? { clientId: translateValue(clientId as string, format, workspaceDir) } : {}), ...(clientSecretEnv ? { clientSecretEnv } : {}) };
    }
    if (format === 'vscode' && (e.oauth !== undefined || e.oauthClientId !== undefined)) throw new Error('OAuth settings are unsupported for this format');
    if (!safeHeaders || !Object.keys(safeHeaders).some(key => key.toLowerCase() === 'authorization')) notices.push(`Server ${name}: client-managed OAuth sessions are not imported; if required, run local-mcp login ${name}. The provider must accept the gateway callback.`);
    return { url: translateValue(e.url, format, workspaceDir, format === 'mcpServers'), ...(safeHeaders ? { headers: safeHeaders } : {}), ...(oauth ? { oauth } : {}), ...(disabled ? { disabled: true } : {}), ...(allowedTools !== undefined ? { allowedTools } : {}) };
  }
  throw new Error('Server must use a supported stdio or HTTP transport');
}
