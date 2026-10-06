import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { parseConfiguration } from '../src/connections/config';
import { Connections } from '../src/connections/manager';
import { RuntimeHost } from '../src/core/host';
import { protocolVersion } from '../src/core/protocol';
import { Plugins } from '../src/plugins/loader';
import { capabilities, setClientPlatform } from '../src/platform/environment';
import { reportEmail } from '../src/ui/app-details';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientPlatform('web');
});
const base = new URL('https://agent.example/app/');
const app = {
  privacyUrl: 'https://service.example/privacy',
  accountUrl: 'https://service.example/account',
  supportEmail: 'help@service.example',
  serviceName: 'Example Service',
  clientName: 'Example App',
};

test('the app section is optional and every field is checked', () => {
  expect(parseConfiguration({ connections: {} }, base).app).toBeUndefined();
  expect(parseConfiguration({ app }, base).app).toEqual(app);
  expect(parseConfiguration({ app: {} }, base).app).toEqual({});
  for (const privacyUrl of [
    'http://service.example/privacy',
    'http://localhost/privacy',
    './privacy',
    'https://service.example/privacy?ref=app',
    'https://service.example/privacy#top',
    'https://user:pass@service.example/privacy',
    'javascript:alert(1)',
    42,
  ])
    expect(() => parseConfiguration({ app: { privacyUrl } }, base)).toThrow('privacyUrl');
  expect(() => parseConfiguration({ app: { accountUrl: 'ftp://x.example/' } }, base)).toThrow(
    'accountUrl',
  );
  for (const supportEmail of [
    'help@service.example?cc=other@example.com',
    'help@service.example&body=x',
    'help@service.example%0Abcc',
    'help @service.example',
    'help',
  ])
    expect(() => parseConfiguration({ app: { supportEmail } }, base)).toThrow('supportEmail');
  for (const serviceName of ['', '  ', 'x'.repeat(61), 'Line\nbreak', 7])
    expect(() => parseConfiguration({ app: { serviceName } }, base)).toThrow('serviceName');
  expect(() => parseConfiguration({ app: [] }, base)).toThrow('app configuration');
});

test('setup state carries the app details and platform, with defaults when unset', async () => {
  const store = new Store(crypto.randomUUID());
  const state = (config: unknown) =>
    new Connections(store, new Plugins(store), parseConfiguration(config, base), base).state();
  expect((await state({})).app).toEqual({});
  setClientPlatform('ios');
  expect(await state({ app })).toMatchObject({ app, platform: 'ios' });
});

test('the connection registers with the configured client name', async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit = {}) => {
      const path = String(url);
      if (path.endsWith('plugin.json'))
        return Response.json({
          id: 'charms',
          name: 'Charms',
          version: '1',
          apiVersion: 1,
          entry: 'plugin.js',
        });
      if (path.endsWith('plugin.js')) return new Response('return {};');
      if (path.endsWith('metadata'))
        return Response.json({
          issuer: 'https://service.example/oauth',
          authorization_endpoint: 'https://service.example/oauth/authorize',
          registration_endpoint: 'https://service.example/oauth/register',
          token_endpoint: 'https://service.example/oauth/token',
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      if (path.endsWith('register')) {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ client_id: 'public-client' });
      }
      throw new Error(path);
    }),
  );
  const charms = {
    url: 'https://service.example/mcp',
    resource: 'https://service.example/mcp',
    issuer: 'https://service.example/oauth',
    metadataUrl: 'https://service.example/metadata',
  };
  for (const config of [{ connections: { charms } }, { connections: { charms }, app }]) {
    const store = new Store(crypto.randomUUID());
    await new Connections(
      store,
      new Plugins(store),
      parseConfiguration(config, base),
      base,
    ).begin();
  }
  expect(bodies.map((body) => body.client_name)).toEqual(['Kinetik OSS', 'Example App']);
});

test('platforms differ only through capabilities', () => {
  expect(capabilities('web')).toEqual({
    linkPlugins: true,
    routinesNeedOpenApp: true,
    continuesAfterLeaving: false,
    notifications: true,
  });
  expect(capabilities('ios').linkPlugins).toBe(false);
  expect(capabilities('android')).toMatchObject({
    linkPlugins: true,
    routinesNeedOpenApp: false,
    continuesAfterLeaving: true,
  });
  for (const desktop of ['macos', 'windows', 'linux'] as const)
    expect(capabilities(desktop)).toMatchObject({
      routinesNeedOpenApp: false,
      notifications: false,
    });
});

test('where plugins cannot come from a link, only plugins served with the app install or update', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith('plugin.json'))
        return Response.json({
          id: path.includes('bundled') ? 'bundled' : 'demo',
          name: 'Demo',
          version: '1',
          apiVersion: 1,
          entry: 'plugin.js',
        });
      if (path.endsWith('plugin.js')) return new Response('return {};');
      throw new Error(path);
    }),
  );
  const host = new RuntimeHost(new Store(crypto.randomUUID()), base, () => {}, { connections: {} });
  const ask = (data: Record<string, unknown>) =>
    new Promise<unknown>(
      (resolve, reject) =>
        void host.handle({ ...data, protocol: protocolVersion }, (reply) =>
          reply.ok ? resolve(reply.result) : reject(new Error(reply.error)),
        ),
    );
  const linked = 'https://plugins.example/demo/plugin.json';
  await ask({ op: 'install', source: linked });
  setClientPlatform('ios');
  await expect(ask({ op: 'update', id: 'demo' })).rejects.toThrow('come with the app');
  await expect(ask({ op: 'enable', id: 'demo', enabled: true })).rejects.toThrow(
    'come with the app',
  );
  await ask({ op: 'enable', id: 'demo', enabled: false });
  await expect(ask({ op: 'install', source: 'https://plugins.example/other/' })).rejects.toThrow(
    'come with the app',
  );
  await ask({ op: 'install', source: new URL('plugins/bundled/plugin.json', base).href });
});

test('a reply report is a plain email with the reply, shortened when long, and the app version', () => {
  const address = new URL(reportEmail('help@service.example', 'Reply & more\n'.repeat(200)));
  expect(address.protocol).toBe('mailto:');
  expect(address.pathname).toBe('help@service.example');
  expect([...new URLSearchParams(address.search).keys()]).toEqual(['subject', 'body']);
  const body = new URLSearchParams(address.search).get('body')!;
  expect(body).toContain('Reply & more');
  expect(body).toContain('[Reply shortened]');
  expect(body).toMatch(/--- Kinetik \S+ \(web\) ---$/);
  expect(address.href.length).toBeLessThan(6000);
  expect(address.href).not.toContain('+');
});

test('on iOS the app scope decides which plugins came with it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) =>
      String(url).endsWith('plugin.json')
        ? Response.json({
            id: 'bundled',
            name: 'B',
            version: '1',
            apiVersion: 1,
            entry: 'plugin.js',
          })
        : new Response('return {};'),
    ),
  );
  setClientPlatform('ios');
  const scope = new URL('tauri://localhost/');
  const host = new RuntimeHost(new Store(crypto.randomUUID()), scope, () => {}, {
    connections: {},
  });
  const ask = (data: Record<string, unknown>) =>
    new Promise<unknown>(
      (resolve, reject) =>
        void host.handle({ ...data, protocol: protocolVersion }, (reply) =>
          reply.ok ? resolve(reply.result) : reject(new Error(reply.error)),
        ),
    );
  await expect(ask({ op: 'install', source: 'https://plugins.example/demo/' })).rejects.toThrow(
    'come with the app',
  );
  // A bundled path passes the guard; outside the native webview the loader then refuses `tauri:`.
  await expect(
    ask({ op: 'install', source: 'tauri://localhost/plugins/charms/plugin.json' }),
  ).rejects.toThrow('Use HTTPS');
});
