import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error('Run package validation with npm run package:check');
const temp = mkdtempSync(join(tmpdir(), 'local-mcp-package-'));
const client = new Client({ name: 'package-validation', version: '1' });
let service;
function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
  });
}
try {
  const [packed] = JSON.parse(
    npm(
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temp],
      root,
    ),
  );
  assert.ok(
    packed && Array.isArray(packed.files),
    'npm pack must return a file manifest',
  );
  const paths = packed.files.map((file) => file.path);
  for (const path of paths) {
    assert.ok(
      path === 'package.json' ||
        ['README.md', 'SECURITY.md', 'LICENSE', 'docs/USAGE.md'].includes(
          path,
        ) ||
        /^dist\/[A-Za-z0-9-]+\.(?:js|d\.ts)$/.test(path) ||
        [
          'dist/web/index.html',
          'dist/web/app.js',
          'dist/web/style.css',
        ].includes(path),
      `Unexpected package file: ${path}`,
    );
  }
  for (const file of readdirSync(join(root, 'dist')).filter(
    (file) => file.endsWith('.js') || file.endsWith('.d.ts'),
  ))
    assert.ok(
      paths.includes(`dist/${file}`),
      `Missing compiled module: ${file}`,
    );
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(paths.includes(manifest.bin['local-mcp']), 'Packed CLI must exist');
  assert.ok(paths.includes(manifest.bin.weftly), 'Branded CLI must exist');
  for (const asset of ['index.html', 'app.js', 'style.css'])
    assert.ok(
      paths.includes(`dist/web/${asset}`),
      `Missing dashboard asset: ${asset}`,
    );
  assert.ok(paths.includes('LICENSE'), 'License must ship with the package');
  writeFileSync(
    join(temp, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  npm(
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      join(temp, packed.filename),
    ],
    temp,
  );
  const cli = join(temp, 'node_modules', manifest.name, 'dist', 'cli.js');
  const help = execFileSync(process.execPath, [cli, 'help'], {
    cwd: temp,
    encoding: 'utf8',
  });
  assert.match(help, /setup FILE/);
  const config = join(temp, 'gateway.json');
  execFileSync(process.execPath, [cli, '--config', config, 'init'], {
    cwd: temp,
    encoding: 'utf8',
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, '--config', config, 'serve'],
      cwd: temp,
      stderr: 'pipe',
    }),
  );
  const names = (await client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(names, ['execute', 'search']);
  await client.close();
  const { startWebService } = await import(
    pathToFileURL(
      join(temp, 'node_modules', manifest.name, 'dist', 'web-service.js'),
    )
  );
  service = await startWebService({
    configPath: join(temp, 'web-config.json'),
    port: 0,
    cliPath: cli,
  });
  for (const asset of ['/', '/app.js', '/style.css']) {
    const response = await fetch(`${service.origin}${asset}`);
    assert.equal(
      response.status,
      200,
      `Installed dashboard asset failed: ${asset}`,
    );
    assert.ok((await response.text()).length > 0);
  }
  const admin = new URL(service.dashboardUrl).hash.slice('#token='.length);
  const connection = await fetch(`${service.origin}/api/connection`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(connection.status, 200);
  const entry = Object.values((await connection.json()).entry.mcpServers)[0];
  await client.connect(
    new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd: temp,
      stderr: 'pipe',
    }),
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ['execute', 'search'],
  );
  console.log(
    `Package validated: ${paths.length} allowed files; isolated production install, dashboard assets, and legacy/bridge handshakes passed.`,
  );
} finally {
  await client.close();
  await service?.close();
  rmSync(temp, { recursive: true, force: true });
}
