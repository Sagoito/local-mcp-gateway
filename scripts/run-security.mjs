import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const semgrepArgs = ['--metrics=off', '--disable-version-check'];
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      SEMGREP_SEND_METRICS: 'off',
      SEMGREP_ENABLE_VERSION_CHECK: '0',
    },
    timeout: 300_000,
  });
  if (result.error) {
    console.error(
      `Cannot run ${command}; install the pinned security tools described in CONTRIBUTING.md.`,
    );
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const mode = process.argv[2];
switch (mode) {
  case 'deps': {
    const npmCli = process.env.npm_execpath;
    if (!npmCli)
      throw new Error('Run this check through npm run security:deps');
    run(process.execPath, [npmCli, 'audit', '--audit-level=high']);
    break;
  }
  case 'sast':
    run('semgrep', [
      'scan',
      ...semgrepArgs,
      '--config',
      '.semgrep.yml',
      '--error',
      '--strict',
      'src',
      'scripts',
      'examples',
      'web',
    ]);
    break;
  case 'rules': {
    // Semgrep 1.180.0 has a directory-target test bug; enumerate fixtures explicitly.
    const fixtures = readdirSync(
      new URL('../security/fixtures/', import.meta.url),
    )
      .filter((name) => name.endsWith('.ts'))
      .sort();
    if (fixtures.length === 0)
      throw new Error('No security rule fixtures found');
    for (const name of fixtures)
      run('semgrep', [
        '--test',
        ...semgrepArgs,
        '--config',
        '.semgrep.yml',
        `security/fixtures/${name}`,
      ]);
    break;
  }
  case 'secrets':
    run('gitleaks', [
      'dir',
      '--config',
      '.gitleaks.toml',
      '--redact',
      '--no-banner',
      '.',
    ]);
    break;
  case 'workflows': {
    const workflows = readdirSync(
      new URL('../.github/workflows/', import.meta.url),
    )
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => `.github/workflows/${name}`);
    if (workflows.length === 0) throw new Error('No workflows found');
    run('actionlint', workflows);
    break;
  }
  default:
    throw new Error('Expected deps, sast, rules, secrets or workflows');
}
