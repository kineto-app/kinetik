import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { Store } from '../src/browser/store';
import { parseConfiguration } from '../src/connections/config';
import { credentialKey, type Credential } from '../src/connections/credentials';
import { Connections } from '../src/connections/manager';
import {
  ConnectionError,
  ContextOverflow,
  ModelFailure,
  OutOfCredits,
  RateLimited,
  SignInRequired,
} from '../src/core/connection-error';
import { Runtime } from '../src/core/runtime';
import type { InstalledPlugin, Model } from '../src/core/types';
import { ModelRouter, provider } from '../src/models/router';
import { retryAfter } from '../src/models/connection-models';
import { Plugins, validateManifest } from '../src/plugins/loader';
import { loadChat } from './chat';
// @ts-expect-error The fixture is plain JavaScript shared with the browser tests.
import { served, servedFixture, servedRequests } from './served-fixture.mjs';

let server: Server;
let origin = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const body = () =>
      new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => resolve(data));
      });
    void (async () => {
      if (await servedFixture(req, res, body)) return;
      // The adapter that comes with the app, as the app serves it.
      const file = req.url?.match(/^\/app\/plugins\/charms\/(plugin\.json|plugin\.js)$/)?.[1];
      if (file)
        res.end(await readFile(new URL(`../public/plugins/charms/${file}`, import.meta.url)));
      else res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  served.mode = 'on';
  servedRequests.length = 0;
});

/** Charms set up as the app sets it up, signed in when `token` is given. */
async function setup(token?: string, agreed = true) {
  const base = new URL(origin + '/app/');
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
  const store = new Store(crypto.randomUUID());
  const plugins = new Plugins(store);
  const connections = new Connections(store, plugins, config, base);
  if (token) {
    const source = new URL('plugins/charms/plugin.json', base).href;
    // An installation made before the adapter declared its models.
    await store.put<InstalledPlugin[]>('plugins', [
      {
        manifest: { id: 'charms', name: 'Charms', version: '0', apiVersion: 1, entry: 'plugin.js' },
        source,
        resolvedSource: source,
        code: 'return {};',
        digest: 'old',
        enabledAt: 1,
        settings: {
          url: config.connections.charms!.url,
          connection: 'charms',
          connectionRevision: 'r1',
        },
      },
    ]);
    await store.put('connection:charms', { preset: config.connections.charms });
    await store.put<Credential>(credentialKey('charms'), { token, revision: 'r1', ready: true });
    if (agreed) await store.put('connection-consent:charms', true);
  }
  const chatgpt: Model = { next: async () => ({ type: 'text', text: 'From ChatGPT' }) };
  const router = new ModelRouter(
    store,
    { ...provider('chatgpt', chatgpt), usable: async () => false },
    provider('custom', chatgpt),
    async () => {
      const models = await connections.modelProvider();
      return models ? [models] : [];
    },
  );
  return { store, connections, router, runtime: new Runtime(store, undefined, router) };
}
const signal = () => new AbortController().signal;
const ask = async (model: Model) =>
  model.next(
    { message: 'Hi', instructions: 'Be brief.', tools: [], pin: { provider: 'charms' } },
    signal(),
  );

test('a manifest declares models only as a path on its connection’s origin', async () => {
  const manifest = { id: 'p', name: 'P', version: '1', apiVersion: 1, entry: 'p.js' };
  expect(
    validateManifest({ ...manifest, modelProvider: { name: ' Served ', path: '/v1/models-api' } })
      .modelProvider,
  ).toEqual({ name: 'Served', path: '/v1/models-api' });
  for (const path of ['https://other.example/v1', '//other.example/v1', 'v1', '/a/../b', '/a?b'])
    expect(() => validateManifest({ ...manifest, modelProvider: { name: 'P', path } })).toThrow(
      'Invalid model provider',
    );
  const { connections } = await setup();
  expect((await connections.modelProvider())!.base).toBe(origin + '/api/kinetik/v1');
});

test('models are offered once the server lists them, and an empty list switches them off', async () => {
  const signedOut = await setup();
  // Before sign-in the app asks without a token, and not again for a while whatever it hears.
  expect((await signedOut.connections.state()).models).toEqual({
    name: 'Kinetik',
    offered: true,
    consented: false,
  });
  expect(servedRequests).toEqual([{ path: 'models', auth: undefined }]);
  await signedOut.connections.state();
  await (await signedOut.connections.modelProvider())!.refresh(true);
  expect(servedRequests).toHaveLength(1);

  const token = 'token-' + crypto.randomUUID();
  const { connections, store } = await setup(token);
  const models = (await connections.modelProvider())!;
  served.mode = 'off';
  expect(await models.refresh(true)).toEqual([]);
  expect((await connections.state()).models?.offered).toBe(false);
  // An answer that says nothing keeps the last list, and a rejected token here signs nobody out.
  served.mode = 'on';
  expect(await models.refresh(true)).toHaveLength(1);
  for (const mode of ['absent', 'models-unauthorized']) {
    served.mode = mode;
    expect(await models.refresh(true)).toHaveLength(1);
  }
  expect((await store.get<Credential>(credentialKey('charms')))!.invalid).toBeUndefined();
});

test('a server without the endpoint is asked at most every few minutes', async () => {
  served.mode = 'absent';
  const { connections } = await setup('token-' + crypto.randomUUID());
  for (let i = 0; i < 3; i++) expect((await connections.state()).models?.offered).toBe(false);
  expect(servedRequests).toHaveLength(1);
});

test('a slow server never holds up the app once it has answered before', async () => {
  const { connections, store } = await setup('token-' + crypto.randomUUID());
  await connections.state();
  // Ten minutes later, the server takes its time.
  await store.update<{ checkedAt: number }>('connection-models:charms', (list) => ({
    ...list,
    checkedAt: 0,
  }));
  served.mode = 'slow';
  const started = Date.now();
  expect((await connections.state()).models?.offered).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
  // The answer still arrives in the background.
  await (await connections.modelProvider())!.refresh();
  expect(servedRequests).toHaveLength(2);
});

test('signed in to Charms alone, a chat streams from Kinetik with the connection’s token', async () => {
  const token = 'token-' + crypto.randomUUID();
  const { runtime, router, connections, store } = await setup(token);
  await connections.state();
  expect(await router.pin()).toEqual({ provider: 'charms', model: 'kinetik' });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello');
  await runtime.run(c.id);
  expect((await loadChat(store, c.id))!.messages.at(-1)).toMatchObject({
    role: 'assistant',
    text: 'Hello from Kinetik.',
  });
  const request = servedRequests.find((r: { path: string }) => r.path === 'chat/completions');
  expect(request.auth).toBe('Bearer ' + token);
  expect(request.body).toMatchObject({ model: 'kinetik', stream: true });
  expect(request.body).not.toHaveProperty('reasoning_effort');
  expect(servedRequests.find((r: { path: string }) => r.path === 'models').auth).toBe(
    'Bearer ' + token,
  );
});

test('each error the server gives means what the contract says for the turn', async () => {
  const token = 'token-' + crypto.randomUUID();
  const { connections, store } = await setup(token);
  const models = (await connections.modelProvider())!;
  await models.refresh(true);
  const cases: [string, new (...args: never[]) => Error][] = [
    ['credits', OutOfCredits],
    ['credits-mid-stream', OutOfCredits],
    ['busy', RateLimited],
    ['too-long', ContextOverflow],
    ['upstream', ConnectionError],
    ['disabled', ModelFailure],
    ['refused', ModelFailure],
    ['unauthorized', SignInRequired],
  ];
  for (const [mode, type] of cases) {
    served.mode = mode;
    const error = await ask(models.model).catch((e) => e);
    expect([mode, error]).toEqual([mode, expect.any(type)]);
    if (mode === 'busy') expect((error as RateLimited).retryAfterMs).toBe(30_000);
    if (mode === 'disabled') {
      // Switched off at once, and back when the server lists it again.
      expect(await models.usable()).toBe(false);
      served.mode = 'on';
      await models.refresh(true);
    }
  }
  // A rejected token asks the user to sign in to Charms again.
  expect((await store.get<Credential>(credentialKey('charms')))!.invalid).toBe(true);
  expect((await connections.state()).charms.status).toBe('reconnect');
  expect(await models.usable()).toBe(false);
});

test('a rate-limited turn waits as long as the server asks', async () => {
  const { runtime, store, connections } = await setup('token-' + crypto.randomUUID());
  await connections.state();
  served.mode = 'busy';
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello');
  const before = Date.now();
  await runtime.run(c.id);
  const chat = (await loadChat(store, c.id))!;
  expect(chat).toMatchObject({ status: 'waiting', waitingFor: 'busy' });
  expect(chat.retryAt! - before).toBeGreaterThanOrEqual(29_000);
  // Coming back to the app does not send it before then.
  await runtime.recover();
  expect((await loadChat(store, c.id))!.status).toBe('waiting');
  expect(
    servedRequests.filter((r: { path: string }) => r.path === 'chat/completions'),
  ).toHaveLength(1);
  expect(retryAfter('2')).toBe(2000);
  expect(retryAfter('99999')).toBe(600_000);
  expect(retryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  expect(retryAfter('soon')).toBeUndefined();
});

test('a chosen model is remembered, and ChatGPT once signed in is the default otherwise', async () => {
  const { store, connections } = await setup('token-' + crypto.randomUUID());
  const models = (await connections.modelProvider())!;
  await models.refresh(true);
  await expect(models.choose('other')).rejects.toThrow('not available');
  await models.choose('kinetik');
  await store.put('model-choice', 'charms');
  let signedIn = true;
  const router = new ModelRouter(
    store,
    {
      ...provider('chatgpt', { next: async () => ({ type: 'text', text: '' }) }),
      usable: async () => signedIn,
    },
    provider('custom', { next: async () => ({ type: 'text', text: '' }) }),
    async () => [models],
  );
  expect((await router.pin()).provider).toBe('charms');
  await store.delete('model-choice');
  expect((await router.pin()).provider).toBe('chatgpt');
  signedIn = false;
  expect((await router.pin()).provider).toBe('charms');
  // ChatGPT chosen on purpose stays chosen while signed out: it asks to sign in again.
  await store.put('model-choice', 'chatgpt');
  expect((await router.pin()).provider).toBe('chatgpt');
  // Switched off on the server: new chats go back to ChatGPT, which asks to sign in.
  served.mode = 'off';
  await models.refresh(true);
  await store.put('model-choice', 'charms');
  expect((await router.pin()).provider).toBe('chatgpt');
});

test('photos and the context size follow what the server lists, with defaults when it does not say', async () => {
  const { connections } = await setup('token-' + crypto.randomUUID());
  const models = (await connections.modelProvider())!;
  const photo = {
    role: 'user',
    content: [
      { type: 'input_text', text: 'What is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ],
  };
  const send = async () => {
    servedRequests.length = 0;
    const step = await models.model.next(
      { message: '', instructions: '', tools: [], history: [photo], pin: { provider: 'charms' } },
      signal(),
    );
    const body = servedRequests.find((r: { path: string }) => r.path === 'chat/completions').body;
    return { step, user: JSON.stringify(body.messages.at(-1)) };
  };
  await models.refresh(true);
  expect(await models.list()).toEqual([
    { id: 'kinetik', name: 'Kinetik', images: true, contextWindow: 200000 },
  ]);
  let { step, user } = await send();
  expect(step.contextWindow).toBe(200000);
  expect(user).toContain('image_url');
  served.mode = 'bare';
  await models.refresh(true);
  ({ step, user } = await send());
  expect(step.contextWindow).toBe(128000);
  expect(user).not.toContain('image_url');
  expect(user).toContain('cannot view images');
});

test('where messages go is agreed once per device, and no turn reaches the model before', async () => {
  const { connections, runtime, store } = await setup('token-' + crypto.randomUUID(), false);
  const models = (await connections.modelProvider())!;
  await connections.state();
  expect((await connections.state()).models?.consented).toBe(false);
  // A turn started any way, as a routine starts one, waits instead of sending.
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello');
  await runtime.run(c.id);
  expect(await loadChat(store, c.id)).toMatchObject({ status: 'waiting', waitingFor: 'signin' });
  expect(servedRequests.filter((r: { path: string }) => r.path === 'chat/completions')).toEqual([]);
  await models.consent();
  expect((await connections.state()).models?.consented).toBe(true);
  expect(await (await setup()).connections.modelProvider().then((m) => m!.consented())).toBe(false);
  await runtime.recover();
  await runtime.run(c.id);
  expect((await loadChat(store, c.id))!.messages.at(-1)).toMatchObject({
    role: 'assistant',
    text: 'Hello from Kinetik.',
  });
});

test('out of credits, the turn ends with a notice that offers ways on, and is not retried', async () => {
  const { runtime, store, connections } = await setup('token-' + crypto.randomUUID());
  await connections.state();
  served.mode = 'credits';
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello');
  await runtime.run(c.id);
  const chat = (await loadChat(store, c.id))!;
  expect(chat.status).toBe('stopped');
  expect(chat.messages.at(-1)).toMatchObject({
    role: 'notice',
    reason: 'credits',
    text: 'You’re out of credits for Kinetik.',
  });
  expect(
    servedRequests.filter((r: { path: string }) => r.path === 'chat/completions'),
  ).toHaveLength(1);
});
