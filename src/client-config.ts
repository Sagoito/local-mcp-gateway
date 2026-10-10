import { resolve } from 'node:path';
import { PROJECT_SLUG } from './brand.js';

export type ClientFormat = 'generic' | 'copilot' | 'vscode' | 'opencode';

/** A bridge entry contains no upstream settings or credentials. */
export function serviceClientConfig(
  format: ClientFormat,
  options: { connectionFile: string; cliPath: string; nodePath?: string },
): Record<string, unknown> {
  if (!['generic', 'copilot', 'vscode', 'opencode'].includes(format))
    throw new Error('Unsupported client format');
  if (
    typeof options?.connectionFile !== 'string' ||
    !options.connectionFile ||
    typeof options?.cliPath !== 'string' ||
    !options.cliPath ||
    (options.nodePath !== undefined &&
      (typeof options.nodePath !== 'string' || !options.nodePath))
  )
    throw new Error('Connection and CLI paths are required');
  const command = resolve(options.nodePath ?? process.execPath);
  const args = [
    resolve(options.cliPath),
    'connect',
    '--connection-file',
    resolve(options.connectionFile),
  ];
  if (format === 'vscode')
    return { servers: { [PROJECT_SLUG]: { type: 'stdio', command, args } } };
  if (format === 'opencode')
    return {
      mcp: {
        [PROJECT_SLUG]: {
          type: 'local',
          command: [command, ...args],
          enabled: true,
        },
      },
    };
  return {
    mcpServers: {
      [PROJECT_SLUG]: {
        ...(format === 'copilot' ? { type: 'local', tools: ['*'] } : {}),
        command,
        args,
      },
    },
  };
}

/** Build a client-specific stdio configuration for launching the local gateway. */
export function clientConfig(
  format: ClientFormat,
  options: { configPath: string; cliPath: string; nodePath?: string },
): Record<string, unknown> {
  if (!['generic', 'copilot', 'vscode', 'opencode'].includes(format)) {
    throw new Error(`Unsupported client format: ${String(format)}`);
  }
  for (const [key, value] of Object.entries({
    configPath: options?.configPath,
    cliPath: options?.cliPath,
    ...(options?.nodePath === undefined ? {} : { nodePath: options.nodePath }),
  })) {
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`${key} must be a non-empty path`);
  }

  const node = resolve(options.nodePath ?? process.execPath);
  const cli = resolve(options.cliPath);
  const config = resolve(options.configPath);
  const args = [cli, '--config', config, 'serve'];

  switch (format) {
    case 'generic':
      return { mcpServers: { 'local-mcp': { command: node, args } } };
    case 'copilot':
      return {
        mcpServers: {
          'local-mcp': { type: 'local', command: node, args, tools: ['*'] },
        },
      };
    case 'vscode':
      return {
        servers: { 'local-mcp': { type: 'stdio', command: node, args } },
      };
    case 'opencode':
      return {
        mcp: {
          'local-mcp': {
            type: 'local',
            command: [node, ...args],
            enabled: true,
          },
        },
      };
  }
}
