import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filesystemServer = path.join(
  root,
  'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
);
const memoryServer = path.join(
  root,
  'node_modules/@modelcontextprotocol/server-memory/dist/index.js',
);

/**
 * Build a gateway config containing the two primary MCP servers and N-1
 * isolated auxiliary filesystem/memory pairs. Auxiliary fixtures deliberately
 * contain unrelated synthetic records so they add discovery/token overhead
 * without revealing answers to the benchmark questions.
 */
export async function createScaleConfig(
  runs,
  runDir,
  pairs = 1,
  native = false,
) {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 16) {
    throw new RangeError('pairs must be an integer from 1 through 16');
  }
  const primaryRoot = path.join(runs, 'fixtures');
  const primaryMemory = path.join(runDir, 'memory.jsonl');
  const gatewayConfig = {
    version: 1,
    servers: {
      filesystem: {
        command: process.execPath,
        args: [filesystemServer, primaryRoot],
      },
      memory: {
        command: process.execPath,
        args: [memoryServer],
        env: { MEMORY_FILE_PATH: primaryMemory },
      },
    },
  };

  for (let pair = 1; pair < pairs; pair++) {
    const suffix = String(pair).padStart(2, '0');
    const fsAlias = `aux-files-${suffix}`;
    const memoryAlias = `aux-memory-${suffix}`;
    const fixtureRoot = path.join(runs, 'aux-fixtures', `pair-${suffix}`);
    const memoryPath = path.join(runDir, `${memoryAlias}.jsonl`);
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, 'README.md'),
      `# Auxiliary fixture ${suffix}\n\nSynthetic scale-test data only.\n`,
    );
    await fs.writeFile(
      path.join(fixtureRoot, 'config.json'),
      JSON.stringify(
        {
          fixture: `auxiliary-${suffix}`,
          purpose: 'MCP scale measurement',
          owner: `Scale Test Team ${suffix}`,
        },
        null,
        2,
      ) + '\n',
    );
    await fs.writeFile(
      memoryPath,
      JSON.stringify({
        type: 'entity',
        name: `Scale Test Fixture ${suffix}`,
        entityType: 'scale-test-only',
        observations: [
          `Owner team: Scale Test Team ${suffix}`,
          `Fixture ID: aux-${suffix}`,
        ],
      }) + '\n',
    );
    gatewayConfig.servers[fsAlias] = {
      command: process.execPath,
      args: [filesystemServer, fixtureRoot],
    };
    gatewayConfig.servers[memoryAlias] = {
      command: process.execPath,
      args: [memoryServer],
      env: { MEMORY_FILE_PATH: memoryPath },
    };
  }

  if (native)
    gatewayConfig.nativeTools = [
      { server: 'filesystem', tool: 'read_text_file' },
      { server: 'filesystem', tool: 'search_files' },
      { server: 'filesystem', tool: 'read_multiple_files' },
      { server: 'memory', tool: 'search_nodes' },
      { server: 'filesystem', tool: 'list_directory' },
    ];

  return {
    gatewayConfig,
    serverCount: pairs * 2,
    fixtureKind:
      pairs === 1 ? 'primary-only' : 'primary-plus-isolated-auxiliary-pairs',
  };
}
