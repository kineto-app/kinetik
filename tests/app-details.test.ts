import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { parseConfiguration } from '../src/connections/config';
import { Connections } from '../src/connections/manager';
import { RuntimeHost } from '../src/core/host';
import { protocolVersion } from '../src/core/protocol';
import { Plugins } from '../src/plugins/loader';
import {
  capabilities,
  clientPlatform,
  guessNativePlatform,
  setClientPlatform,
} from '../src/platform/environment';
import { mailtoLimit, reportEmail } from '../src/ui/app-details';

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
    '.help@service.example',
    'help.@service.example',
    'he..lp@service.example',
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

test('a platform the app cannot name gets the most restrictive capabilities and no header', () => {
  setClientPlatform('freebsd');
  expect(clientPlatform()).toBe('unknown');
  expect(capabilities()).toEqual({
    linkPlugins: false,
    routinesNeedOpenApp: true,
    continuesAfterLeaving: false,
    notifications: false,
  });
  // An iPad's webview looks like a Mac, so a Mac user agent proves nothing.
  expect(guessNativePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit')).toBe(
    'unknown',
  );
  expect(guessNativePlatform('Mozilla/5.0 (Linux; Android 15) AppleWebKit')).toBe('android');
  expect(guessNativePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)')).toBe('ios');
  expect(guessNativePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
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

test('a reply report is a plain email under the length limit, cut between characters', () => {
  const short = new URL(reportEmail('help@service.example', 'Reply & more'));
  expect(short.protocol).toBe('mailto:');
  expect(short.pathname).toBe('help@service.example');
  expect([...new URLSearchParams(short.search).keys()]).toEqual(['subject', 'body']);
  const body = new URLSearchParams(short.search).get('body')!;
  expect(body).toContain('Reply & more');
  expect(body).not.toContain('[Reply shortened]');
  expect(body).toMatch(/--- Kinetik \S+ \(web\) ---$/);
  for (const piece of ['Reply & more\n', 'Ответ модели. ', '模型的回答。', 'Done 👍🏽 ']) {
    const reply = piece.repeat(400);
    const address = reportEmail('help@service.example', reply);
    expect(address.length).toBeLessThanOrEqual(mailtoLimit);
    expect(address).not.toContain('+');
    // Decoding throws on a split character.
    const text = new URLSearchParams(new URL(address).search).get('body')!;
    const kept = text.slice(
      text.indexOf('--- Reply ---\n') + 14,
      text.indexOf('\n[Reply shortened]'),
    );
    expect(kept.length).toBeGreaterThan(50);
    expect(reply.startsWith(kept)).toBe(true);
    expect(kept).not.toMatch(/[\uD800-\uDBFF]$/);
  }
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

test('on iOS, a link plugin turned on before the upgrade is turned off and never runs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) =>
      String(url).endsWith('plugin.json')
        ? Response.json({
            id: 'linked',
            name: 'L',
            version: '1',
            apiVersion: 1,
            entry: 'plugin.js',
          })
        : new Response('return { tools: {} };'),
    ),
  );
  const store = new Store(crypto.randomUUID());
  const before = new Plugins(store);
  await before.install('https://plugins.example/linked/plugin.json');
  await before.enable('linked', true);
  const [record] = await before.list();
  setClientPlatform('ios');
  const host = new RuntimeHost(store, base, () => {}, { connections: {} });
  await host.initialize();
  expect((await host.runtime.plugins.list())[0].enabledAt).toBeNull();
  // Chats and jobs pin the records they started with; those are left out too.
  const pinned = { ...record, enabledAt: 1 };
  expect((await host.runtime.plugins.snapshot({}, [pinned])).sources).toEqual([]);
  const bundled = { ...pinned, source: new URL('plugins/charms/plugin.json', base).href };
  expect((await host.runtime.plugins.snapshot({}, [bundled])).sources).toHaveLength(1);
});

test('setup state says when ChatGPT replies pass through the service', async () => {
  const store = new Store(crypto.randomUUID());
  const config = parseConfiguration(
    {
      chatgpt: {
        mode: 'browser',
        jwksUrl: './connections/chatgpt/keys',
        modelRelay: './connections/chatgpt/model/',
      },
    },
    base,
  );
  const state = await new Connections(store, new Plugins(store), config, base, async () => ({
    connected: false,
  })).state();
  expect(state.chatgpt.relay).toBe(true);
});
