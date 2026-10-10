import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));
const hashes = [
  ...new Set(readFileSync(config, 'utf8').match(/\b[a-f0-9]{64}\b/g)),
];
assert.equal(
  hashes.length,
  4,
  'Review the tests when digest exceptions change',
);
const temp = mkdtempSync(join(tmpdir(), 'gateway-secret-rules-'));
const unknownHash = createHash('sha256')
  .update('unrecognized artifact')
  .digest('hex');
assert.ok(!hashes.includes(unknownHash));
const syntheticToken = randomBytes(48).toString('base64url');
const cases = [
  ...hashes.map((hash) => ({
    name: 'known artifact digest',
    path: 'benchmark/results/probe.json',
    data: { 'auth.js': hash },
    leaks: 0,
  })),
  {
    name: 'unknown result digest',
    path: 'benchmark/results/probe.json',
    data: { 'auth.js': unknownHash },
    leaks: 1,
  },
  {
    name: 'known digest outside results',
    path: 'source/probe.json',
    data: { 'auth.js': hashes[0] },
    leaks: 1,
  },
  {
    name: 'separate value on the same line',
    path: 'benchmark/results/probe.json',
    data: { 'auth.js': hashes[0], api_key: syntheticToken },
    leaks: 1,
  },
  {
    name: 'credential in historical results',
    path: 'benchmark/results/probe.json',
    data: { api_key: syntheticToken },
    leaks: 1,
  },
  {
    name: 'known digest used under a different key',
    path: 'benchmark/results/probe.json',
    data: { api_key: hashes[0] },
    leaks: 1,
  },
];
try {
  for (const [index, test] of cases.entries()) {
    const directory = join(temp, String(index));
    const file = join(directory, test.path);
    const report = join(temp, `report-${index}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(test.data)}\n`);
    const result = spawnSync(
      'gitleaks',
      [
        'dir',
        '--config',
        config,
        '--redact',
        '--no-banner',
        '--report-format',
        'json',
        '--report-path',
        report,
        '.',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    if (result.error)
      throw new Error('Install Gitleaks as described in CONTRIBUTING.md', {
        cause: result.error,
      });
    assert.equal(
      result.status,
      test.leaks === 0 ? 0 : 1,
      `Unexpected scan status: ${test.name}`,
    );
    const findings = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(
      findings.length,
      test.leaks,
      `Incorrect exception scope: ${test.name}`,
    );
    for (const finding of findings) {
      assert.equal(finding.RuleID, 'generic-api-key');
      assert.equal(finding.File.replaceAll('\\', '/'), test.path);
    }
  }
  console.log(
    `Secret scan exceptions validated: ${cases.length} positive and negative cases passed.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
