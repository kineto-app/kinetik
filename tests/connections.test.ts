import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { Plugins } from '../src/plugins/loader';
import { Connections } from '../src/connections/manager';
import { parseConfiguration } from '../src/connections/config';
import { connectionToken, credentialKey } from '../src/connections/credentials';
import { McpClient } from '../src/plugins/mcp';

afterEach(() => vi.unstubAllGlobals());
const base = new URL('https://agent.example/app/');
const config = parseConfiguration(
  {
    connections: {
      charms: {
        url: './connections/charms/mcp',
        resource: 'https://service.example/mcp',
        issuer: 'https://service.example/oauth',
        metadataUrl: './connections/charms/metadata',
      },
    },
  },
  base,
);

function fixture() {
  const store = new Store(crypto.randomUUID());
  const plugins = new Plugins(store);
  const connections = new Connections(store, plugins, config, base);
  const metadata = {
    issuer: 'https://service.example/oauth',
    authorization_endpoint: 'https://service.example/oauth/authorize',
    registration_endpoint: 'https://agent.example/app/register',
    token_endpoint: 'https://agent.example/app/token',
    revocation_endpoint: 'https://agent.example/app/revoke',
    code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['none'],
  };
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit = {}) => {
      const path = String(url);
      calls.push({ url: path, init });
      if (path.endsWith('plugin.json'))
        return Response.json({
          id: 'charms',
          name: 'Charms',
          version: '1',
          apiVersion: 1,
          entry: 'plugin.js',
        });
      if (path.endsWith('plugin.js'))
        return new Response(
          'return { skills: { async sync() { return { revision: "1", skills: [{ name:"skill", description:"Native skill", path:"skill/SKILL.md", content:"# Help" }] }; } } };',
        );
      if (path.endsWith('metadata')) return Response.json(metadata);
      if (path.endsWith('register')) return Response.json({ client_id: 'public-client' });
      if (path.endsWith('token'))
        return Response.json({ access_token: 'test-secret', token_type: 'Bearer' });
      if (path.endsWith('revoke')) return new Response(null, { status: 200 });
      throw new Error(path);
    }),
  );
  return { store, plugins, connections, calls, metadata };
}

test('authorization uses PKCE and consumes state once before enabling native skills', async () => {
  const f = fixture();
  const authorize = new URL(await f.connections.begin());
  expect(authorize.origin).toBe('https://service.example');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('resource')).toBe('https://service.example/mcp');
  expect((await f.plugins.list())[0].enabledAt).toBeNull();
  await f.connections.finish({
    state: authorize.searchParams.get('state')!,
    code: 'single-use-code',
  });
  const exchange = f.calls.find((c) => c.url.endsWith('/token'))!;
  const verifier = (exchange.init.body as URLSearchParams).get('code_verifier')!;
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url');
  expect(challenge).toBe(authorize.searchParams.get('code_challenge'));
  expect(
    await connectionToken(
      f.store,
      'charms',
      (await f.plugins.list())[0].settings.connectionRevision,
    ),
  ).toBe('test-secret');
  expect((await f.connections.state()).charms.status).toBe('connected');
  expect(JSON.stringify(await f.plugins.list())).not.toContain('test-secret');
  expect(JSON.stringify(await f.store.entries('skills:'))).toContain('Native skill');
  await expect(
    f.connections.finish({ state: authorize.searchParams.get('state')!, code: 'single-use-code' }),
  ).rejects.toThrow('expired');
  await f.connections.disconnect();
  expect(await f.store.get(credentialKey('charms'))).toBeNull();
  expect((await f.plugins.list())[0].enabledAt).toBeNull();
});

test('reopening a deep link preserves a disabled connection and its pinned code', async () => {
  const f = fixture();
  const url = new URL(await f.connections.begin());
  await f.connections.finish({ state: url.searchParams.get('state')!, code: 'code' });
  await f.connections.setEnabled(false);
  const before = await f.plugins.list();
  await f.connections.prepare();
  expect(await f.plugins.list()).toEqual(before);
  expect((await f.connections.state()).charms.status).toBe('disabled');
});

test('wrong state, issuer mismatch, denied consent and disabling never exchange an authorization code', async () => {
  const f = fixture();
  const url = new URL(await f.connections.begin());
  const state = url.searchParams.get('state')!;
  await expect(f.connections.finish({ state: 'attacker', code: 'code' })).rejects.toThrow(
    'expired',
  );
  await expect(
    f.connections.finish({ state, code: 'code', issuer: 'https://attacker.example' }),
  ).rejects.toThrow('expired');
  await expect(f.connections.finish({ state, error: 'access_denied' })).rejects.toThrow(
    'wasn’t connected',
  );
  const next = new URL(await f.connections.begin());
  await f.connections.setEnabled(false);
  await expect(
    f.connections.finish({ state: next.searchParams.get('state')!, code: 'code' }),
  ).rejects.toThrow('expired');
  expect(f.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(0);
});

test('rejects mismatched metadata and insecure endpoints before registering a client', async () => {
  const f = fixture();
  f.metadata.issuer = 'https://attacker.example';
  await expect(f.connections.begin()).rejects.toThrow('secure sign-in');
  f.metadata.issuer = 'https://service.example/oauth';
  f.metadata.token_endpoint = 'https://attacker.example/token';
  await expect(f.connections.begin()).rejects.toThrow('Unrecognized');
  expect(f.calls.filter((c) => c.url.endsWith('/register'))).toHaveLength(0);
});

test('configuration only accepts safe deployment endpoints and same-origin credential helpers', () => {
  expect(() =>
    parseConfiguration({ chatgpt: { apiBase: 'https://attacker.example/' } }, base),
  ).toThrow('origin');
  expect(() =>
    parseConfiguration(
      {
        connections: {
          charms: { ...config.connections.charms, url: 'http://service.example/mcp' },
        },
      },
      base,
    ),
  ).toThrow('HTTPS');
});

test('an unauthorized MCP response invalidates the managed token without retrying a tool', async () => {
  const invalid = vi.fn(async () => {});
  const request = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', request);
  const client = new McpClient('https://service.example/mcp', async () => 'secret', invalid);
  await expect(client.call('write', {})).rejects.toThrow('Reconnect Charms');
  expect(invalid).toHaveBeenCalledWith('secret');
  expect(request).toHaveBeenCalledTimes(1);
});

test('a failed skill sync blocks new credentials until retry and old jobs cannot use a new login', async () => {
  const f = fixture();
  const login = async () => {
    const url = new URL(await f.connections.begin());
    return f.connections.finish({ state: url.searchParams.get('state')!, code: 'code' });
  };
  await login();
  const oldRevision = (await f.plugins.list())[0].settings.connectionRevision;
  const sync = vi
    .spyOn(f.plugins, 'sync')
    .mockResolvedValueOnce({ skills: [], warnings: ['unavailable'] });
  await expect(login()).rejects.toThrow('skills could not be loaded');
  expect((await f.connections.state()).charms.status).toBe('disabled');
  const revision = (await f.plugins.list())[0].settings.connectionRevision;
  await expect(connectionToken(f.store, 'charms', revision)).rejects.toThrow('Finish connecting');
  await expect(connectionToken(f.store, 'charms', oldRevision)).rejects.toThrow('Reconnect');
  sync.mockRestore();
  await f.connections.activate();
  expect((await f.connections.state()).charms.status).toBe('connected');
  expect(await connectionToken(f.store, 'charms', revision)).toBe('test-secret');
  await expect(connectionToken(f.store, 'charms', oldRevision)).rejects.toThrow('Reconnect');
});

test('MCP requests advertise embedded app support on each tool call', async () => {
  const requests: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'initialize' ? { protocolVersion: '2025-11-25' } : {},
      });
    }),
  );
  await new McpClient('https://service.example/mcp').call('render', {});
  const call = requests.find((request) => request.method === 'tools/call');
  expect(
    call.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions[
      'io.modelcontextprotocol/ui'
    ].mimeTypes,
  ).toEqual(['text/html;profile=mcp-app']);
});
