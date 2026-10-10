import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerConfig } from '../src/types.js';
import { assertCallArguments, assertToolAllowed, isToolAllowed, LIMIT_DEFAULTS } from '../src/policy.js';

test('server allowlists are optional, exact, and treat wildcard characters literally', () => {
  const unrestricted: ServerConfig = { command: 'node' };
  const disabled: ServerConfig = { command: 'node', disabled: true };
  const denied: ServerConfig = { command: 'node', allowedTools: [] };
  const restricted: ServerConfig = { command: 'node', allowedTools: ['search', 'tool*'] };
  assert.equal(isToolAllowed(unrestricted, 'anything'), true);
  assert.equal(isToolAllowed(disabled, 'anything'), false);
  assert.equal(isToolAllowed(denied, 'anything'), false);
  assert.equal(isToolAllowed(restricted, 'search'), true);
  assert.equal(isToolAllowed(restricted, 'tool*'), true);
  assert.equal(isToolAllowed(restricted, 'toolName'), false);
  assert.throws(() => assertToolAllowed(restricted, 'private-secret-tool'), /^Error: Tool is not allowed by server policy$/);
  assert.equal(LIMIT_DEFAULTS.maxTools, 5000);
  assert.equal(LIMIT_DEFAULTS.maxCatalogBytes, 32 * 1024 * 1024);
});

test('call arguments must be a serializable object within the UTF-8 byte limit', () => {
  assertCallArguments({ ok: 'yes' }, 64);
  assert.throws(() => assertCallArguments(null), /JSON object/);
  assert.throws(() => assertCallArguments(['x']), /JSON object/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => assertCallArguments(circular), /JSON-serializable/);
  assert.throws(() => assertCallArguments({ text: 'é' }, 12), /size limit/);
  assertCallArguments({ text: 'é' }, 13);
});
