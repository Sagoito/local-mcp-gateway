#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { defaultConfigPath, loadConfig, saveConfig } from './config.js';
import type { GatewayConfig, ServerConfig } from './types.js';

type Parsed = { command?: string; positional: string[]; configPath: string; options: Record<string, string | string[] | boolean | undefined> };

function parse(argv: string[]): Parsed {
  let configPath = defaultConfigPath();
  const tokens = [...argv];
  // Accept --config before or after the subcommand.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--') break;
    if (tokens[i] === '--config') {
      if (!tokens[i + 1]) throw new Error('--config requires a path');
      configPath = tokens[i + 1]!;
      tokens.splice(i, 2); i--;
    } else if (tokens[i]?.startsWith('--config=')) {
      configPath = tokens[i]!.slice('--config='.length);
      if (!configPath) throw new Error('--config requires a path');
      tokens.splice(i, 1); i--;
    }
  }
  const command = tokens.shift();
  if (!command) return { positional: [], configPath, options: {} };
  if (command === 'add') {
    const split = tokens.indexOf('--');
    const tail = split >= 0 ? tokens.splice(split) : [];
    const parsed = parseArgs({ args: tokens, options: {
      url: { type: 'string' }, header: { type: 'string', multiple: true }, env: { type: 'string', multiple: true }, 'oauth-client-id': { type: 'string' },
    }, allowPositionals: true, strict: true });
    const positionals = [...parsed.positionals, ...tail.slice(1)];
    if (tail.length) positionals.splice(parsed.positionals.length, 0, '--');
    return { command, positional: positionals, configPath, options: parsed.values };
  }
  const parsed = parseArgs({ args: tokens, options: {}, allowPositionals: true, strict: true });
  return { command, positional: parsed.positionals, configPath, options: parsed.values };
}

function usage(): string {
  return `Usage: local-mcp [--config PATH] <command>\n\nCommands:\n  init\n  add NAME --url URL [--header 'Name=Value'] [--oauth-client-id ID]\n  add NAME [--env KEY=VALUE]... -- COMMAND [ARGS...]\n  remove NAME\n  list\n  login NAME\n  serve\n  doctor`;
}

function headerPairs(value: string | string[] | boolean | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [String(value)];
  const headers: Record<string, string> = Object.create(null) as Record<string,string>;
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq < 1) throw new Error('Invalid header; expected Name=Value');
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`Invalid header name: ${name}`);
    headers[name] = value;
  }
  return headers;
}

async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const { command, positional, options, configPath } = parsed;
  if (!command || command === 'help' || command === '--help') { console.log(usage()); return; }
  if (command === 'init') {
    const config = await loadConfig(configPath);
    await saveConfig(configPath, config);
    console.log(`Initialized ${configPath}`); return;
  }
  if (command === 'add') {
    const name = positional[0];
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || ['__proto__','prototype','constructor'].includes(name)) throw new Error('add requires a safe server NAME');
    let server: ServerConfig;
    if (typeof options.url === 'string') {
      if (positional.length !== 1) throw new Error('Unexpected arguments after server name');
      if (options.env !== undefined) throw new Error('--env is only valid with stdio servers');
      const headers = headerPairs(options.header);
      server = { url: options.url, ...(headers ? { headers } : {}), ...(typeof options['oauth-client-id'] === 'string' ? { oauth: { clientId: options['oauth-client-id'] } } : {}) };
    } else {
      if (options.header !== undefined || options['oauth-client-id'] !== undefined) throw new Error('HTTP options require --url');
      const sep = positional.indexOf('--');
      const commandName = sep >= 0 ? positional[sep + 1] : positional[1];
      const args = sep >= 0 ? positional.slice(sep + 2) : positional.slice(2);
      if (!commandName) throw new Error('add requires -- COMMAND [ARGS...] or --url URL');
      const env: Record<string, string> = Object.create(null) as Record<string,string>;
      const envOptions: string[] = typeof options.env === 'string' ? [options.env]
        : Array.isArray(options.env) ? options.env
        : options.env === undefined ? [] : (() => { throw new Error('Invalid --env option'); })();
      for (const item of envOptions) {
        const eq = item.indexOf('=');
        if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.slice(0, eq))) throw new Error('Invalid environment assignment; expected KEY=VALUE');
        env[item.slice(0, eq)] = item.slice(eq + 1);
      }
      server = { command: commandName, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
    }
    const config = await loadConfig(configPath);
    if (Object.hasOwn(config.servers, name)) throw new Error(`Server ${name} already exists; remove it before adding a replacement`);
    config.servers[name] = server;
    await saveConfig(configPath, config);
    console.log(`Added ${name}`); return;
  }
  if (command === 'remove') {
    if (positional.length !== 1) throw new Error('remove requires exactly one server NAME');
    const config = await loadConfig(configPath);
    if (!Object.hasOwn(config.servers, positional[0]!)) throw new Error(`No server named ${positional[0]}`);
    delete config.servers[positional[0]!];
    await saveConfig(configPath, config);
    console.log(`Removed ${positional[0]}`); return;
  }
  if (command === 'list') {
    const config = await loadConfig(configPath);
    for (const [name, server] of Object.entries(config.servers)) {
      const detail = 'command' in server ? `stdio ${server.command}` : `http ${new URL(server.url.replace(/\$\{[^}]+\}/g, 'placeholder')).origin}`;
      console.log(`${name}\t${server.disabled ? 'disabled' : 'enabled'}\t${detail}`);
    }
    return;
  }
  if (command === 'login') {
    if (positional.length !== 1) throw new Error('login requires exactly one server NAME');
    const config = await loadConfig(configPath);
    const server = config.servers[positional[0]!];
    if (!server || !('url' in server)) throw new Error(`No HTTP server named ${positional[0]}`);
    const { login } = await import('./auth.js');
    await login(positional[0]!, server, configPath);
    console.log(`Logged in to ${positional[0]}`); return;
  }
  if (command === 'serve') {
    if (positional.length) throw new Error('serve takes no arguments');
    const { serve } = await import('./server.js');
    await serve(configPath); return;
  }
  if (command === 'doctor') {
    const config = await loadConfig(configPath);
    const { createUpstreams } = await import('./upstreams.js');
      const upstreams = createUpstreams(config, configPath);
    try {
      const tools = await upstreams.listTools();
      const errors = typeof (upstreams as unknown as { getErrors?: unknown }).getErrors === 'function'
        ? (upstreams as unknown as { getErrors(): Record<string, string> }).getErrors() : {};
      const counts = new Map<string, number>();
      for (const tool of tools) counts.set(tool.server, (counts.get(tool.server) ?? 0) + 1);
      for (const [name, server] of Object.entries(config.servers)) {
        if (server.disabled) console.log(`${name}\tdisabled\t0 tools`);
        else if (errors[name]) console.log(`${name}\terror\t${errors[name]!.replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]')}`);
        else console.log(`${name}\tok\t${counts.get(name) ?? 0} tools`);
      }
      for (const tool of tools) if (!Object.hasOwn(config.servers, tool.server)) console.log(`${tool.server}\terror\tunexpected upstream result`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`doctor failed: ${message.replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]')}`);
      process.exitCode = 1;
    } finally { await upstreams.close(); }
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

run(process.argv.slice(2)).catch(error => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`local-mcp: ${message}`);
  process.exitCode = 1;
});
