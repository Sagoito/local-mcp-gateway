import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlStore, ControlError } from '../src/control-store.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'control-store-')),
    path = join(dir, 'config.json');
  const store = createControlStore(path, async () => {});
  return {
    dir,
    path,
    store,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test('new state defaults code execution off and views redact credential values', async () => {
  const f = await fixture();
  try {
    let s = await f.store.state();
    assert.deepEqual(s.config.security, { allowCode: false });
    await f.store.upsert({
      revision: s.revision,
      name: 'local',
      server: {
        command: 'node',
        args: ['--token', 'ultrasecret'],
        env: { TOKEN: 'ultrasecret', REF: '${TOKEN}' },
      },
    });
    s = await f.store.state();
    assert.deepEqual(s.config.security, { allowCode: false });
    assert.deepEqual(s.servers[0].envKeys, ['TOKEN', 'REF']);
    assert.deepEqual(s.servers[0].envReferences, { REF: 'TOKEN' });
    assert.equal(JSON.stringify(s).includes('ultrasecret'), false);
    assert.equal(JSON.stringify(s).includes('TOKEN'), true);
  } finally {
    await f.close();
  }
});

test('stale writes conflict and omitted secret map is preserved while empty clears it', async () => {
  const f = await fixture();
  try {
    let s = await f.store.state();
    s = await f.store.upsert({
      revision: s.revision,
      name: 'x',
      server: { command: 'node', env: { KEY: 'secret' } },
    });
    await assert.rejects(
      f.store.upsert({
        revision: 'stale',
        name: 'x',
        server: { command: 'node' },
      }),
      (e: unknown) => e instanceof ControlError && e.status === 409,
    );
    s = await f.store.upsert({
      revision: s.revision,
      name: 'x',
      server: { command: 'node' },
    });
    assert.deepEqual(s.servers[0].envKeys, ['KEY']);
    s = await f.store.upsert({
      revision: s.revision,
      name: 'x',
      server: { command: 'node', env: {} },
    });
    assert.deepEqual(s.servers[0].envKeys, []);
  } finally {
    await f.close();
  }
});

test('strict input validation never returns supplied secret in errors', async () => {
  const f = await fixture();
  try {
    const s = await f.store.state();
    await assert.rejects(
      f.store.upsert({
        revision: s.revision,
        name: 'x',
        server: {
          command: 'node',
          env: { TOKEN: 'do-not-leak' },
          extra: 'do-not-leak',
        },
      }),
      (e: unknown) =>
        e instanceof ControlError &&
        e.status === 400 &&
        !e.message.includes('do-not-leak'),
    );
    await assert.rejects(
      f.store.policy({ revision: s.revision, security: { allowCode: 'yes' } }),
      (e: unknown) => e instanceof ControlError && e.status === 400,
    );
  } finally {
    await f.close();
  }
});

test('import preview is sanitized and failed/conflicting apply is atomic', async () => {
  const f = await fixture();
  try {
    let s = await f.store.state();
    const original =
      '{"mcpServers":{"imported":{"command":"node","env":{"TOKEN":"literal-secret"}}}}';
    const preview = await f.store.import({
      revision: s.revision,
      text: original,
      workspaceDir: '/tmp',
      apply: false,
    });
    assert.equal(JSON.stringify(preview).includes('literal-secret'), false);
    assert.equal(
      await readFile(f.path, 'utf8').then(
        () => true,
        () => false,
      ),
      false,
    );
    await writeFile(
      f.path,
      JSON.stringify({
        version: 1,
        servers: { existing: { command: 'node', env: { TOKEN: 'kept' } } },
      }),
    );
    s = await f.store.state();
    await assert.rejects(
      f.store.import({
        revision: s.revision,
        text: '{"mcpServers":{"existing":{"command":"x"}}}',
        workspaceDir: '/tmp',
        apply: true,
      }),
      (e: unknown) => e instanceof ControlError && e.status === 409,
    );
    assert.equal(JSON.stringify(await f.store.state()).includes('kept'), false);
  } finally {
    await f.close();
  }
});

test('policy mutation commits validated security only', async () => {
  const f = await fixture();
  try {
    let s = await f.store.state();
    s = await f.store.policy({
      revision: s.revision,
      security: { allowCode: false },
    });
    assert.deepEqual(s.config.security, { allowCode: false });
    assert.equal(
      JSON.parse(await readFile(f.path, 'utf8')).security.allowCode,
      false,
    );
  } finally {
    await f.close();
  }
});

test('HTTP URL query and fragment stay private while edits retain the endpoint', async () => {
  const f = await fixture();
  try {
    let s = await f.store.state();
    s = await f.store.upsert({
      revision: s.revision,
      name: 'remote',
      server: {
        url: 'https://example.com/mcp?token=private#fragment',
        headers: { Authorization: 'literal-secret' },
      },
    });
    assert.equal(JSON.stringify(s).includes('private'), false);
    assert.equal(JSON.stringify(s).includes('literal-secret'), false);
    assert.equal(s.servers[0].url, 'https://example.com/mcp');
    assert.equal(s.servers[0].hasPrivateUrlParts, true);
    s = await f.store.upsert({
      revision: s.revision,
      name: 'remote',
      server: { headers: {} },
    });
    assert.equal(s.servers[0].url, 'https://example.com/mcp');
    assert.deepEqual(s.servers[0].headerKeys, []);
  } finally {
    await f.close();
  }
});

test('transport switch keeps supplied new credentials and validates fields', async () => {
  const f = await fixture();
  try {
    let s = await f.store.state();
    s = await f.store.upsert({
      revision: s.revision,
      name: 'switch',
      server: { command: 'node', env: { OLD: 'old-secret' } },
    });
    s = await f.store.upsert({
      revision: s.revision,
      name: 'switch',
      server: {
        url: 'https://example.com/mcp',
        headers: { Authorization: '${TOKEN}' },
      },
    });
    assert.equal(s.servers[0].transport, 'http');
    assert.deepEqual(s.servers[0].headerKeys, ['Authorization']);
    await assert.rejects(
      f.store.upsert({
        revision: s.revision,
        name: 'switch',
        server: { command: 'node', env: {}, headers: { Authorization: 'new' } },
      }),
      (e: unknown) => e instanceof ControlError && e.status === 400,
    );
  } finally {
    await f.close();
  }
});

test('redacted argument placeholders preserve existing argument secrets on edit', async () => {
  const f = await fixture();
  try {
    let s = await f.store.state();
    s = await f.store.upsert({
      revision: s.revision,
      name: 'args',
      server: {
        command: 'node',
        args: ['--token=secret-arg'],
        env: { TOKEN: 'secret-arg' },
      },
    });
    assert.equal(s.servers[0].argsContainSecrets, true);
    assert.deepEqual(s.servers[0].args, ['--token=[redacted]']);
    s = await f.store.upsert({
      revision: s.revision,
      name: 'args',
      server: {
        command: 'node',
        args: ['--token=[redacted]'],
        env: { TOKEN: 'secret-arg' },
      },
    });
    assert.equal(s.servers[0].argsContainSecrets, true);
    assert.deepEqual(s.servers[0].args, ['--token=[redacted]']);
  } finally {
    await f.close();
  }
});
