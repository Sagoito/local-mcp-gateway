#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, loadConfig, saveConfig } from './config.js';
import type { ServerConfig } from './types.js';

type Parsed = {
  command?: string;
  positional: string[];
  configPath: string;
  options: Record<string, string | string[] | boolean | undefined>;
};

function parse(argv: string[]): Parsed {
  let configPath = defaultConfigPath();
  const tokens = [...argv];
  // Accept --config before or after the subcommand.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--') break;
    if (tokens[i] === '--config') {
      if (!tokens[i + 1]) throw new Error('--config requires a path');
      configPath = tokens[i + 1]!;
      tokens.splice(i, 2);
      i--;
    } else if (tokens[i]?.startsWith('--config=')) {
      configPath = tokens[i].slice('--config='.length);
      if (!configPath) throw new Error('--config requires a path');
      tokens.splice(i, 1);
      i--;
    }
  }
  const command = tokens.shift();
  if (!command) return { positional: [], configPath, options: {} };
  if (command === 'web' || command === 'connect') {
    const definitions: ParseArgsOptionsConfig =
      command === 'web'
        ? { port: { type: 'string' } }
        : {
            'connection-file': { type: 'string' },
            url: { type: 'string' },
            'token-env': { type: 'string' },
          };
    const parsed = parseArgs({
      args: tokens,
      options: definitions,
      allowPositionals: false,
      strict: true,
    });
    const values: Parsed['options'] = {};
    for (const [name, value] of Object.entries(parsed.values)) {
      if (value !== undefined && typeof value !== 'string')
        throw new Error(`Invalid option: ${name}`);
      values[name] = value;
    }
    return {
      command,
      positional: [],
      configPath,
      options: values,
    };
  }
  if (command === 'add') {
    const split = tokens.indexOf('--');
    const tail = split >= 0 ? tokens.splice(split) : [];
    const parsed = parseArgs({
      args: tokens,
      options: {
        url: { type: 'string' },
        header: { type: 'string', multiple: true },
        env: { type: 'string', multiple: true },
        'oauth-client-id': { type: 'string' },
        'allow-tool': { type: 'string', multiple: true },
        'no-tools': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
    const positionals = [...parsed.positionals, ...tail.slice(1)];
    if (tail.length) positionals.splice(parsed.positionals.length, 0, '--');
    return {
      command,
      positional: positionals,
      configPath,
      options: parsed.values,
    };
  }
  if (
    command === 'import' ||
    command === 'setup' ||
    command === 'client-config'
  ) {
    const definitions: ParseArgsOptionsConfig =
      command === 'client-config'
        ? { client: { type: 'string' } }
        : {
            format: { type: 'string' },
            workspace: { type: 'string' },
            server: { type: 'string', multiple: true },
            'dry-run': { type: 'boolean' },
            ...(command === 'setup'
              ? { client: { type: 'string' as const } }
              : {}),
          };
    const parsed = parseArgs({
      args: tokens,
      options: definitions,
      allowPositionals: true,
      strict: true,
    });
    return {
      command,
      positional: parsed.positionals,
      configPath,
      options: parsed.values as Parsed['options'],
    };
  }
  const parsed = parseArgs({
    args: tokens,
    options: {},
    allowPositionals: true,
    strict: true,
  });
  return {
    command,
    positional: parsed.positionals,
    configPath,
    options: parsed.values,
  };
}

function usage(): string {
  return `Usage: weftly [--config PATH] <command>\n\nCommands:\n  web [--port PORT]\n  connect --connection-file FILE\n  connect --url URL --token-env NAME\n  setup FILE [--client generic|copilot|vscode|opencode] [--dry-run]\n  import FILE [--format auto|mcpServers|vscode|opencode] [--workspace DIR] [--server NAME]... [--dry-run]\n  client-config [--client generic|copilot|vscode|opencode]\n  init\n  add NAME --url URL [--header 'Name=Value'] [--oauth-client-id ID] [--allow-tool TOOL]...\n  add NAME [--env KEY=VALUE]... [--allow-tool TOOL]... -- COMMAND [ARGS...]\n  add NAME --no-tools -- COMMAND [ARGS...]\n  remove NAME\n  list\n  login NAME\n  serve\n  doctor\n\nsetup accepts the same import options; diagnostics go to stderr and the agent entry goes to stdout.`;
}

function headerPairs(
  value: string | string[] | boolean | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [String(value)];
  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq < 1) throw new Error('Invalid header; expected Name=Value');
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
      throw new Error(`Invalid header name: ${name}`);
    headers[name] = value;
  }
  return headers;
}

async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const { command, positional, options, configPath } = parsed;
  if (!command || command === 'help' || command === '--help') {
    console.log(usage());
    return;
  }
  if (command === 'web') {
    const rawPort = options.port;
    if (
      rawPort !== undefined &&
      (typeof rawPort !== 'string' ||
        !/^\d+$/.test(rawPort) ||
        Number(rawPort) > 65535)
    )
      throw new Error('--port must be an integer from 0 to 65535');
    const { startWebService } = await import('./web-service.js');
    const service = await startWebService({
      configPath,
      port: rawPort === undefined ? undefined : Number(rawPort),
      cliPath: fileURLToPath(import.meta.url),
    });
    console.log(
      `Weftly dashboard: ${service.dashboardUrl}\nKeep this service running while your agents use it.`,
    );
    const stop = () => {
      void service.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (command === 'connect') {
    const { connectBridge } = await import('./bridge.js');
    const bridge = await connectBridge({
      connectionFile: options['connection-file'] as string | undefined,
      url: options.url as string | undefined,
      tokenEnv: options['token-env'] as string | undefined,
      onError: () => {
        console.error('Bridge transport failed');
        process.exitCode = 1;
      },
    });
    const stop = () => {
      void bridge.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (command === 'client-config') {
    if (positional.length)
      throw new Error('client-config takes no positional arguments');
    const { clientConfig } = await import('./client-config.js');
    console.log(
      JSON.stringify(
        clientConfig((options.client ?? 'generic') as never, {
          configPath,
          cliPath: fileURLToPath(import.meta.url),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'import' || command === 'setup') {
    if (positional.length !== 1)
      throw new Error(
        `${command} requires exactly one existing client configuration FILE`,
      );
    const source = resolve(positional[0]);
    const destination = resolve(configPath);
    const canonicalDestination = await realpath(destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return destination;
      throw new Error('Cannot access gateway configuration');
    });
    let sourceReal: string;
    try {
      sourceReal = await realpath(source);
    } catch {
      throw new Error('Cannot read client configuration FILE');
    }
    if (sourceReal === canonicalDestination)
      throw new Error(
        'Client source and gateway configuration must be different files',
      );
    if ((await stat(sourceReal)).size > 8 * 1024 * 1024)
      throw new Error('Client configuration exceeds the 8 MiB import limit');
    let input: string;
    try {
      input = await readFile(sourceReal, 'utf8');
    } catch {
      throw new Error('Cannot read client configuration FILE');
    }
    if (Buffer.byteLength(input) > 8 * 1024 * 1024)
      throw new Error('Client configuration exceeds the 8 MiB import limit');
    const { importClientConfig } = await import('./import.js');
    const imported = importClientConfig(input, {
      format: (options.format ?? 'auto') as never,
      workspaceDir: resolve(String(options.workspace ?? process.cwd())),
      names: options.server as string[] | undefined,
    });
    for (const notice of imported.notices) console.error(`Note: ${notice}`);
    if (imported.issues.length) {
      for (const issue of imported.issues)
        console.error(`${issue.server}: ${issue.message}`);
      throw new Error(
        'Import blocked; no configuration was written. Resolve these settings or select compatible entries with --server NAME',
      );
    }
    const config = await loadConfig(destination);
    const names = Object.keys(imported.servers);
    if (!names.length) throw new Error('No servers selected for import');
    for (const name of names) {
      const server = imported.servers[name];
      if (
        Object.hasOwn(config.servers, name) &&
        !isDeepStrictEqual(config.servers[name], server)
      )
        throw new Error(
          `Server ${name} already exists with different settings; no configuration was written`,
        );
      config.servers[name] = server;
      console.error(
        `${options['dry-run'] ? 'Would import' : 'Ready to import'} ${name}${server.disabled ? ' (disabled)' : ''}`,
      );
    }
    let entry: Record<string, unknown> | undefined;
    if (command === 'setup') {
      const { clientConfig } = await import('./client-config.js');
      entry = clientConfig((options.client ?? 'generic') as never, {
        configPath: destination,
        cliPath: fileURLToPath(import.meta.url),
      });
    }
    const newConfig = await stat(destination).then(
      () => false,
      (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw new Error('Cannot access gateway configuration');
      },
    );
    if (newConfig) config.security = { allowCode: false };
    if (!options['dry-run']) {
      await saveConfig(destination, config);
      console.error(`Imported ${names.length} server(s) into ${destination}`);
    } else console.error('Preview only; no files changed.');
    if (newConfig)
      console.error(
        'New gateway configuration uses structured calls; JavaScript is disabled.',
      );
    console.error(
      'Source configuration was not changed. Replace the imported direct entries in your agent with the gateway entry to avoid duplicate tools.',
    );
    if (entry) console.log(JSON.stringify(entry, null, 2));
    return;
  }
  if (command === 'init') {
    const config = await loadConfig(configPath);
    await saveConfig(configPath, config);
    console.log(`Initialized ${configPath}`);
    return;
  }
  if (command === 'add') {
    const name = positional[0];
    if (
      !name ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
      ['__proto__', 'prototype', 'constructor'].includes(name)
    )
      throw new Error('add requires a safe server NAME');
    let server: ServerConfig;
    if (typeof options.url === 'string') {
      if (positional.length !== 1)
        throw new Error('Unexpected arguments after server name');
      if (options.env !== undefined)
        throw new Error('--env is only valid with stdio servers');
      const headers = headerPairs(options.header);
      server = {
        url: options.url,
        ...(headers ? { headers } : {}),
        ...(typeof options['oauth-client-id'] === 'string'
          ? { oauth: { clientId: options['oauth-client-id'] } }
          : {}),
      };
    } else {
      if (
        options.header !== undefined ||
        options['oauth-client-id'] !== undefined
      )
        throw new Error('HTTP options require --url');
      const sep = positional.indexOf('--');
      const commandName = sep >= 0 ? positional[sep + 1] : positional[1];
      const args = sep >= 0 ? positional.slice(sep + 2) : positional.slice(2);
      if (!commandName)
        throw new Error('add requires -- COMMAND [ARGS...] or --url URL');
      const env: Record<string, string> = Object.create(null) as Record<
        string,
        string
      >;
      const envOptions: string[] =
        typeof options.env === 'string'
          ? [options.env]
          : Array.isArray(options.env)
            ? options.env
            : options.env === undefined
              ? []
              : (() => {
                  throw new Error('Invalid --env option');
                })();
      for (const item of envOptions) {
        const eq = item.indexOf('=');
        if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.slice(0, eq)))
          throw new Error('Invalid environment assignment; expected KEY=VALUE');
        env[item.slice(0, eq)] = item.slice(eq + 1);
      }
      server = {
        command: commandName,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
    }
    const config = await loadConfig(configPath);
    if (Object.hasOwn(config.servers, name))
      throw new Error(
        `Server ${name} already exists; remove it before adding a replacement`,
      );
    if (options['no-tools'] && options['allow-tool'] !== undefined)
      throw new Error('Use --no-tools or --allow-tool, not both');
    if (options['no-tools']) server.allowedTools = [];
    else if (options['allow-tool'] !== undefined)
      server.allowedTools = Array.isArray(options['allow-tool'])
        ? options['allow-tool']
        : [String(options['allow-tool'])];
    config.servers[name] = server;
    await saveConfig(configPath, config);
    console.log(`Added ${name}`);
    return;
  }
  if (command === 'remove') {
    if (positional.length !== 1)
      throw new Error('remove requires exactly one server NAME');
    const config = await loadConfig(configPath);
    if (!Object.hasOwn(config.servers, positional[0]))
      throw new Error(`No server named ${positional[0]}`);
    delete config.servers[positional[0]];
    if (config.inlineTools)
      config.inlineTools = config.inlineTools.filter(
        (t) => t.server !== positional[0],
      );
    if (config.nativeTools)
      config.nativeTools = config.nativeTools.filter(
        (t) => t.server !== positional[0],
      );
    await saveConfig(configPath, config);
    console.log(`Removed ${positional[0]}`);
    return;
  }
  if (command === 'list') {
    const config = await loadConfig(configPath);
    for (const [name, server] of Object.entries(config.servers)) {
      const detail =
        'command' in server
          ? `stdio ${server.command}`
          : `http ${new URL(server.url.replace(/\$\{[^}]+\}/g, 'placeholder')).origin}`;
      const policy =
        server.allowedTools === undefined
          ? 'unrestricted tools'
          : `${server.allowedTools.length} allowed tools`;
      console.log(
        `${name}\t${server.disabled ? 'disabled' : 'enabled'}\t${detail}\t${policy}`,
      );
    }
    return;
  }
  if (command === 'login') {
    if (positional.length !== 1)
      throw new Error('login requires exactly one server NAME');
    const config = await loadConfig(configPath);
    const server = config.servers[positional[0]];
    if (!server || !('url' in server))
      throw new Error(`No HTTP server named ${positional[0]}`);
    const { login } = await import('./auth.js');
    await login(positional[0], server, configPath);
    console.log(`Logged in to ${positional[0]}`);
    return;
  }
  if (command === 'serve') {
    if (positional.length) throw new Error('serve takes no arguments');
    const { serve } = await import('./server.js');
    await serve(configPath);
    return;
  }
  if (command === 'doctor') {
    const config = await loadConfig(configPath);
    const { createUpstreams } = await import('./upstreams.js');
    const upstreams = createUpstreams(config, configPath);
    try {
      const tools = await upstreams.listTools();
      const errors =
        typeof (upstreams as unknown as { getErrors?: unknown }).getErrors ===
        'function'
          ? (
              upstreams as unknown as { getErrors(): Record<string, string> }
            ).getErrors()
          : {};
      const counts = new Map<string, number>();
      for (const tool of tools)
        counts.set(tool.server, (counts.get(tool.server) ?? 0) + 1);
      for (const [name, server] of Object.entries(config.servers)) {
        if (server.disabled) console.log(`${name}\tdisabled\t0 tools`);
        else if (errors[name]) {
          process.exitCode = 1;
          console.log(
            `${name}\terror\t${errors[name].replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]')}`,
          );
          console.error(
            `${name}: check the executable, working directory and gateway environment${'url' in server && server.oauth !== false ? `; for OAuth, run local-mcp --config "${resolve(configPath)}" login ${name}` : ''}.`,
          );
        } else console.log(`${name}\tok\t${counts.get(name) ?? 0} tools`);
      }
      for (const tool of tools)
        if (!Object.hasOwn(config.servers, tool.server))
          console.log(`${tool.server}\terror\tunexpected upstream result`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `doctor failed: ${message.replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]')}`,
      );
      process.exitCode = 1;
    } finally {
      await upstreams.close();
    }
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

run(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`local-mcp: ${message}`);
  process.exitCode = 1;
});
