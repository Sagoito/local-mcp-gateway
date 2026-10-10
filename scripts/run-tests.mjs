import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  ...readdirSync(new URL('../test/', import.meta.url))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`),
  ...readdirSync(new URL('../benchmark/', import.meta.url))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `benchmark/${name}`),
].sort();
if (tests.length === 0) throw new Error('No test files found');
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...tests],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
