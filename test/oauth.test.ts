import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createAuthProvider, startCallbackServer } from '../src/auth.js';

const resourceUrl = 'https://resource.example/mcp';
const issuer = 'https://auth.example';

test('OAuth discovery, DCR, PKCE authorization-code exchange, and refresh use SDK auth with durable provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-oauth-flow-'));
  const configPath = join(dir, 'config.json');
  const requests: Array<{ url: string; method: string; body?: URLSearchParams | string }> = [];
  let authorizationUrl: URL | undefined;
  let codeExchanged = false;
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body instanceof URLSearchParams ? new URLSearchParams(init.body) : typeof init.body === 'string' ? init.body : undefined;
    requests.push({ url, method, body });
    if (url === 'https://resource.example/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: resourceUrl, authorization_servers: [issuer], scopes_supported: ['read', 'offline_access'] });
    }
    if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
      return json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === `${issuer}/register` && method === 'POST') {
      return json({ ...JSON.parse(String(body)), client_id: 'test-public-client' });
    }
    if (url === `${issuer}/token` && method === 'POST') {
      const params = body instanceof URLSearchParams ? body : new URLSearchParams(body);
      if (params.get('grant_type') === 'authorization_code') {
        codeExchanged = true;
        assert.equal(params.get('code'), 'test-authorization-code');
        assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:43127/callback');
        const verifier = await provider.codeVerifier();
        assert.equal(params.get('code_verifier'), verifier);
        assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorizationUrl?.searchParams.get('code_challenge'));
        assert.equal(authorizationUrl?.searchParams.get('code_challenge_method'), 'S256');
        return json({ access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'refresh-one');
      return json({ access_token: 'access-two', refresh_token: 'refresh-two', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error(`Unexpected mock OAuth request: ${method} ${url}`);
  };
  const provider = createAuthProvider('remote', { url: resourceUrl }, configPath);
  provider.redirectToAuthorization = async url => { authorizationUrl = new URL(url); };
  try {
    assert.equal(await auth(provider, { serverUrl: resourceUrl, fetchFn }), 'REDIRECT');
    assert.ok(authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'test-public-client');
    assert.equal(authorizationUrl.searchParams.get('state'), await provider.state?.());
    assert.ok(authorizationUrl.searchParams.get('code_challenge'));
    assert.equal(requests.some(r => r.url.endsWith('/register') && r.method === 'POST'), true);

    assert.equal(await auth(provider, { serverUrl: resourceUrl, authorizationCode: 'test-authorization-code', fetchFn }), 'AUTHORIZED');
    assert.equal(codeExchanged, true);
    assert.equal((await provider.tokens())?.access_token, 'access-one');

    const restartedProvider = createAuthProvider('remote', { url: resourceUrl }, configPath);
    assert.equal(await auth(restartedProvider, { serverUrl: resourceUrl, fetchFn }), 'AUTHORIZED');
    assert.equal((await restartedProvider.tokens())?.access_token, 'access-two');
    const tokenRequests = requests.filter(r => r.url === `${issuer}/token`);
    assert.deepEqual(tokenRequests.map(r => (r.body as URLSearchParams).get('grant_type')), ['authorization_code', 'refresh_token']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('OAuth rejects insecure or credential-bearing expanded and authorization URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-oauth-url-'));
  const previous = process.env.LOCAL_MCP_TEST_HOST;
  try {
    process.env.LOCAL_MCP_TEST_HOST = 'remote.example';
    assert.throws(() => createAuthProvider('remote', {url: 'http://${LOCAL_MCP_TEST_HOST}/mcp'}, join(dir,'config.json')), /HTTPS/);
    process.env.LOCAL_MCP_TEST_HOST = 'user:private-secret@remote.example';
    assert.throws(() => createAuthProvider('remote', {url: 'https://${LOCAL_MCP_TEST_HOST}/mcp'}, join(dir,'config.json')), /user information/);
    const provider = createAuthProvider('remote', {url: resourceUrl}, join(dir,'config.json'), true);
    await assert.rejects(provider.redirectToAuthorization(new URL('http://remote.example/authorize')), /HTTPS/);
    await assert.rejects(provider.redirectToAuthorization(new URL('https://user:secret@remote.example/authorize')), /user information/);
    await assert.rejects(provider.redirectToAuthorization(new URL('javascript:alert(1)')), /HTTPS/);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_MCP_TEST_HOST;
    else process.env.LOCAL_MCP_TEST_HOST = previous;
    await rm(dir, {recursive:true,force:true});
  }
});

test('loopback OAuth callback validates state and handles a completed response only once', async () => {
  const callback=await startCallbackServer(async url=>url.searchParams.get('state')==='test-state');
  try {
    assert.equal((await fetch('http://127.0.0.1:43127/other')).status,404);
    assert.equal((await fetch('http://127.0.0.1:43127/callback?state=wrong&code=wrong')).status,400);
    assert.equal((await fetch('http://127.0.0.1:43127/callback?state=test-state')).status,400);
    assert.equal((await fetch('http://127.0.0.1:43127/callback?state=test-state&code=first')).status,200);
    assert.equal((await callback.result).searchParams.get('code'),'first');
    assert.equal((await fetch('http://127.0.0.1:43127/callback?state=test-state&code=second')).status,409);
  } finally {await callback.close();}
});
