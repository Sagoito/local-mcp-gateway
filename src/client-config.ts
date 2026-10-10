import { resolve } from 'node:path';

export type ClientFormat = 'generic' | 'copilot' | 'vscode' | 'opencode';

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
