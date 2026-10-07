import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { BrowserChatGPT } from '../src/connections/chatgpt';
import { parseConfiguration } from '../src/connections/config';

const base = 'https://agent.test/oss/';
const issuer = 'https://auth.openai.com';
const encode = (value: string | Uint8Array) => Buffer.from(value).toString('base64url');
let keys: CryptoKeyPair;
let publicKey: JsonWebKey;
let flow: URL;
let client: BrowserChatGPT;
let store: Store;
let refreshes: number;
let badSignature = false;
let deniedScope = false;
let expires = 3600;
let tokenCalls = 0;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
});
beforeEach(() => {
  let tail = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, work: () => Promise<unknown>) => {
        const next = tail.then(work);
        tail = next.then(
          () => {},
          () => {},
        );
        return next;
      },
    },
  });
  badSignature = deniedScope = false;
  refreshes = tokenCalls = 0;
  expires = 3600;
  store = new Store(crypto.randomUUID());
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init?.credentials).toBe('omit');
    if (url === base + 'connections/chatgpt/keys')
      return Response.json({ keys: [{ ...publicKey, kid: 'test-key', use: 'sig' }] });
    if (url.endsWith('/oauth/token')) {
      tokenCalls++;
      const body = init?.body as URLSearchParams;
      if (body.get('grant_type') === 'refresh_token') {
        refreshes++;
        expect(body.get('refresh_token')).toBe('placeholder-refresh-one');
        return Response.json({
          access_token: 'placeholder-access-two',
          refresh_token: 'placeholder-refresh-two',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      expect(body.get('client_id')).toBe('client-one');
      const challenge = encode(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(body.get('code_verifier')!),
          ),
        ),
      );
      expect(challenge).toBe(flow.searchParams.get('code_challenge'));
      const head = encode(JSON.stringify({ alg: 'RS256', kid: 'test-key' }));
      const payload = encode(
        JSON.stringify({
          iss: issuer,
          aud: 'client-one',
          sub: 'person',
          nonce: flow.searchParams.get('nonce'),
          exp: Date.now() / 1000 + 600,
        }),
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          keys.privateKey,
          new TextEncoder().encode(head + '.' + payload),
        ),
      );
      if (badSignature) signature[0] ^= 1;
      return Response.json({
        access_token: 'placeholder-access-one',
        refresh_token: 'placeholder-refresh-one',
        token_type: 'Bearer',
        expires_in: expires,
        scope: deniedScope ? 'openid' : 'openid chatgpt.tokens.use.direct',
        id_token: head + '.' + payload + '.' + encode(signature),
      });
    }
    if (url.endsWith('/models'))
      return Response.json({
        models: [
          { slug: 'another-model', visibility: 'list' },
          { slug: 'gpt-6.1-sol', visibility: 'list' },
        ],
      });
    if (String(url).endsWith('/responses')) {
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.model).toBe('gpt-6.1-sol');
      expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
      return new Response('data: test\n\n');
    }
    if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
    throw new Error('Unexpected request');
  });
  client = new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher);
});
async function begin() {
  flow = new URL((await client.login()).url);
}
function callback() {
  return (
    'http://127.0.0.1:1455/auth/callback?' +
    new URLSearchParams({
      code: 'test-code',
      state: flow.searchParams.get('state')!,
      client_id: 'client-one',
    })
  );
}
test('retains login across worker restarts in the dedicated credential store', async () => {
  await store.put('session', {
    access: 'placeholder-old-access',
    refresh: 'placeholder-old-refresh',
  });
  await begin();
  const host = flow.searchParams.get('ext_agent_host_id');
  await client.callback(callback());
  expect(await client.status()).toEqual({
    connected: true,
    model: 'gpt-6.1-sol',
    account: 'person',
  });
  expect(await store.get('session')).toMatchObject({
    access: 'placeholder-access-one',
    refresh: 'placeholder-refresh-one',
  });
  expect(
    await new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher).status(),
  ).toEqual({ connected: true, model: 'gpt-6.1-sol', account: 'person' });
  await expect(client.callback(callback())).rejects.toThrow('does not match');
  expect(tokenCalls).toBe(1);
  await client.login();
  const again = new URL((await client.login()).url);
  expect(again.searchParams.get('client_id')).toBe('client-one');
  expect(again.searchParams.get('ext_agent_host_id')).toBe(host);
});
test('rejects wrong state and callback hosts before exchanging any code', async () => {
  await begin();
  for (const url of [
    callback().replace('127.0.0.1', 'evil.test'),
    callback().replace('state=', 'state=wrong'),
    callback() + '&state=second',
  ])
    await expect(client.callback(url)).rejects.toThrow('does not match');
  expect(tokenCalls).toBe(0);
});
test('rejects forged identity and missing subscription consent', async () => {
  await begin();
  badSignature = true;
  await expect(client.callback(callback())).rejects.toThrow('signature rejected');
  expect((await client.status()).connected).toBe(false);
  await begin();
  badSignature = false;
  deniedScope = true;
  await expect(client.callback(callback())).rejects.toThrow('not granted');
  expect((await client.status()).connected).toBe(false);
});
test('serializes token rotation across concurrent model requests', async () => {
  expires = 1;
  await begin();
  await client.callback(callback());
  await Promise.all(
    [client, new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher)].map(
      (instance) =>
        instance.responses(
          { account: 'person', request: { store: true, model: 'wrong' } },
          new AbortController().signal,
        ),
    ),
  );
  expect(refreshes).toBe(1);
  expect(await store.get('session')).toMatchObject({
    access: 'placeholder-access-two',
    refresh: 'placeholder-refresh-two',
  });
  const calls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/responses'));
  expect(calls).toHaveLength(2);
  for (const [, init] of calls)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer placeholder-access-two');
});
test('sign-out clears local credentials and accepts empty revocation success', async () => {
  await begin();
  await client.callback(callback());
  await client.logout();
  expect((await client.status()).connected).toBe(false);
  expect(
    (await new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher).status())
      .connected,
  ).toBe(false);
  expect(await store.get('session')).toBeNull();
  await expect(
    client.responses({ account: 'person', request: {} }, new AbortController().signal),
  ).rejects.toThrow('Connect ChatGPT');
});
test('browser mode is deployment controlled and keys must be same origin', () => {
  expect(
    parseConfiguration(
      { chatgpt: { mode: 'browser', jwksUrl: './connections/chatgpt/keys' } },
      new URL(base),
    ).chatgpt,
  ).toEqual({ mode: 'browser', jwksUrl: base + 'connections/chatgpt/keys' });
  expect(() =>
    parseConfiguration(
      { chatgpt: { mode: 'browser', jwksUrl: 'https://evil.test/keys' } },
      new URL(base),
    ),
  ).toThrow('origin');
});

test.each([
  ['/oauth/token', 'token exchange'],
  ['/connections/chatgpt/keys', 'identity keys'],
  ['/models', 'model list'],
])(
  'identifies a failed sign-in request at %s without exposing credentials',
  async (path, stage) => {
    const request = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((input, init) =>
      String(input).endsWith(path)
        ? Promise.reject(new TypeError('Failed to fetch placeholder-error-token'))
        : request(input, init),
    );
    await begin();
    await expect(client.callback(callback())).rejects.toThrow(
      stage === 'model list'
        ? 'Could not load models. Check your connection and try again.'
        : `Could not reach ChatGPT (${stage}). Check your connection, then restart sign-in.`,
    );
    expect((await client.status()).connected).toBe(false);
  },
);

test('sends only catalog and inference through the optional relay, never OAuth or refresh tokens', async () => {
  const relay = base + 'connections/chatgpt/model/';
  client = new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher, relay);
  expires = 1;
  await begin();
  await client.callback(callback());
  await client.responses({ account: 'person', request: {} }, new AbortController().signal);
  await client.logout();
  const relayed = fetcher.mock.calls.filter(([url]) => String(url).startsWith(relay));
  expect(relayed.map(([url]) => url)).toEqual([relay + 'models', relay + 'responses']);
  for (const [, init] of relayed) {
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    expect(JSON.stringify(init)).not.toContain('refresh-');
  }
  expect(refreshes).toBe(1);
  expect(JSON.stringify(await store.entries(''))).not.toMatch(
    /placeholder-access-one|placeholder-refresh-one|placeholder-access-two|placeholder-refresh-two/,
  );
});

test('rejects relay destinations outside the deployment origin and malformed base paths', () => {
  for (const modelRelay of [
    'https://evil.test/',
    './relay',
    './relay/?token=secret',
    './relay/#hash',
  ]) {
    expect(() =>
      parseConfiguration(
        { chatgpt: { mode: 'browser', jwksUrl: './keys', modelRelay } },
        new URL(base),
      ),
    ).toThrow();
  }
  expect(
    parseConfiguration(
      { chatgpt: { mode: 'browser', jwksUrl: './keys', modelRelay: './connections/model/' } },
      new URL(base),
    ).chatgpt,
  ).toEqual({ mode: 'browser', jwksUrl: base + 'keys', modelRelay: base + 'connections/model/' });
});

test('temporary refresh failures retain login, while revoked access clears it durably', async () => {
  expires = 1;
  await begin();
  await client.callback(callback());
  const request = fetcher.getMockImplementation()!;
  let status = 503;
  fetcher.mockImplementation((input, init) =>
    String(input).endsWith('/oauth/token')
      ? Promise.resolve(Response.json({ error: 'refresh failed' }, { status }))
      : request(input, init),
  );
  const send = () =>
    client.responses({ account: 'person', request: {} }, new AbortController().signal);
  await expect(send()).rejects.toThrow('could not be renewed');
  expect(await store.get('session')).toMatchObject({ refresh: 'placeholder-refresh-one' });
  status = 401;
  await expect(send()).rejects.toThrow('Reconnect ChatGPT');
  expect(await store.get('session')).toBeNull();
  expect(
    (await new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher).status())
      .connected,
  ).toBe(false);
});

test('logout removes durable credentials even when remote revocation fails', async () => {
  await begin();
  await client.callback(callback());
  const request = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, init) =>
    String(input).endsWith('/oauth/revoke')
      ? Promise.reject(new TypeError('Failed to fetch'))
      : request(input, init),
  );
  await expect(client.logout()).rejects.toThrow('Signed out on this device');
  expect(await store.get('session')).toBeNull();
  expect((await client.status()).connected).toBe(false);
});

test('native callback ports remain bound to the attempt and reauthorization retains the identity hint', async () => {
  flow = new URL((await client.login('http://127.0.0.1:43561/auth/callback')).url);
  await expect(client.callback(callback())).rejects.toThrow('does not match');
  await client.callback(callback().replace(':1455/', ':43561/'));
  const session = await store.get<{ idToken: string; scopes: string[] }>('session');
  expect(session?.scopes).toContain('chatgpt.tokens.use.direct');
  const returning = new URL((await client.login('http://127.0.0.1:43562/auth/callback')).url);
  expect(returning.searchParams.get('client_id')).toBe('client-one');
  expect(returning.searchParams.get('id_token_hint')).toBe(session?.idToken);
  await client.logout();
  const afterLogout = new URL((await client.login()).url);
  expect(afterLogout.searchParams.has('id_token_hint')).toBe(false);
});

test('sign-in loads the identity keys while the code is exchanged, not after', async () => {
  const request = fetcher.getMockImplementation()!;
  let keysRequested!: () => void;
  const keys = new Promise<void>((resolve) => (keysRequested = resolve));
  fetcher.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/keys')) keysRequested();
    // The exchange answers only once the keys were asked for.
    if (String(input).endsWith('/oauth/token'))
      await Promise.race([
        keys,
        new Promise((_, reject) => setTimeout(() => reject(new Error('keys waited')), 1000)),
      ]);
    return request(input, init);
  });
  await begin();
  await client.callback(callback());
  expect((await client.status()).connected).toBe(true);
});

test('existing logins migrate to GPT-6.1 Sol without reauthorization', async () => {
  await begin();
  await client.callback(callback());
  await store.update<Record<string, unknown>>('session', (session) => ({
    ...session,
    model: 'older-model',
  }));
  fetcher.mockClear();
  const reopened = new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher);
  await reopened.responses(
    { account: 'person', request: { model: 'older-model', reasoning: { effort: 'high' } } },
    new AbortController().signal,
  );
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    'https://api.openai.com/v1/models',
    'https://api.openai.com/v1/responses',
  ]);
  expect(await store.get('session')).toMatchObject({
    model: 'gpt-6.1-sol',
    refresh: 'placeholder-refresh-one',
  });
  await reopened.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/models'))).toHaveLength(1);
});

test('a first sign-in without the preferred model starts on the first listed model', async () => {
  const request = fetcher.getMockImplementation()!;
  const sent: string[] = [];
  fetcher.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/models'))
      return Response.json({
        models: [
          { slug: 'hidden-model', visibility: 'hide' },
          { slug: 'another-model', visibility: 'list' },
        ],
      });
    if (String(input).endsWith('/responses')) {
      sent.push(JSON.parse(String(init?.body)).model);
      return new Response('data: test\n\n');
    }
    return request(input, init);
  });
  await begin();
  await client.callback(callback());
  expect(await store.get('session')).toMatchObject({ model: 'another-model' });
  await client.responses({ account: 'person', request: {} }, new AbortController().signal);
  await client.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(sent).toEqual(['another-model', 'another-model']);
});

test('unavailable preferred model does not silently fall back or discard an existing login', async () => {
  await begin();
  await client.callback(callback());
  await store.update<Record<string, unknown>>('session', (session) => ({
    ...session,
    model: 'older-model',
  }));
  const request = fetcher.getMockImplementation()!;
  fetcher.mockClear();
  fetcher.mockImplementation((input, init) =>
    String(input).endsWith('/models')
      ? Promise.resolve(Response.json({ models: [{ slug: 'another-model', visibility: 'list' }] }))
      : request(input, init),
  );
  await expect(
    client.responses({ account: 'person', request: {} }, new AbortController().signal),
  ).rejects.toThrow('GPT-6.1 Sol is not available for this ChatGPT account.');
  expect((await client.status()).connected).toBe(true);
  expect(await store.get('session')).toMatchObject({
    refresh: 'placeholder-refresh-one',
    model: 'older-model',
  });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/responses'))).toBe(false);
});

test('model picker preserves catalog order and names and excludes hidden models', async () => {
  await begin();
  await client.callback(callback());
  const request = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, init) =>
    String(input).endsWith('/models')
      ? Promise.resolve(
          Response.json({
            models: [
              { slug: 'first', display_name: 'First model', visibility: 'list' },
              { slug: 'hidden', visibility: 'hidden' },
              null,
              { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
              { slug: 'first', display_name: 'Duplicate', visibility: 'list' },
            ],
          }),
        )
      : request(input, init),
  );
  expect(await client.models()).toEqual({
    selected: 'gpt-6.1-sol',
    reasoning: 'medium',
    models: [
      { slug: 'first', name: 'First model' },
      { slug: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    ],
  });
});

test('chosen model survives reopening and token refresh and controls inference', async () => {
  await begin();
  await client.callback(callback());
  await client.chooseModel('another-model');
  await store.update<any>('session', (session) => ({ ...session, expires: 1 }));
  const request = fetcher.getMockImplementation()!;
  let sent: any;
  fetcher.mockImplementation((input, init) => {
    if (String(input).endsWith('/responses')) {
      sent = JSON.parse(String(init?.body));
      return Promise.resolve(new Response('data: test\n\n'));
    }
    return request(input, init);
  });
  const reopened = new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher);
  await reopened.responses(
    { account: 'person', request: { model: 'stale-model', reasoning: { effort: 'high' } } },
    new AbortController().signal,
  );
  expect(refreshes).toBe(1);
  expect(sent).toMatchObject({ model: 'another-model', store: false, stream: true });
  expect(sent.reasoning).toBeUndefined();
  expect(await reopened.status()).toMatchObject({ model: 'another-model' });
  await reopened.chooseModel('gpt-6.1-sol');
  await reopened.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(sent).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'medium' } });
});

test('unavailable model selection preserves current model and login', async () => {
  await begin();
  await client.callback(callback());
  await expect(client.chooseModel('unlisted')).rejects.toThrow('not available');
  expect(await client.status()).toMatchObject({ connected: true, model: 'gpt-6.1-sol' });
});

test('model selection cannot overwrite a session changed while the catalog loads', async () => {
  await begin();
  await client.callback(callback());
  const request = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (input, init) => {
    const response = await request(input, init);
    if (String(input).endsWith('/models')) await store.put('session', null);
    return response;
  });
  await expect(client.chooseModel('another-model')).rejects.toThrow('account changed');
  expect(await store.get('session')).toBeNull();
});

test('reasoning levels come from the catalog, persist per model, and reach inference', async () => {
  await begin();
  await client.callback(callback());
  const request = fetcher.getMockImplementation()!;
  let sent: any;
  fetcher.mockImplementation((input, init) => {
    if (String(input).endsWith('/models'))
      return Promise.resolve(
        Response.json({
          models: [
            {
              slug: 'gpt-6.1-sol',
              display_name: 'GPT-6.1 Sol',
              visibility: 'list',
              default_reasoning_level: 'low',
              supported_reasoning_levels: [
                { effort: 'low', description: 'Fast' },
                { effort: 'xhigh', description: 'Deep' },
                { effort: 'ultra', description: 'Delegates' },
                { effort: 'Bad Value' },
              ],
            },
            { slug: 'plain', display_name: 'Plain', visibility: 'list' },
          ],
        }),
      );
    if (String(input).endsWith('/responses')) {
      sent = JSON.parse(String(init?.body));
      return Promise.resolve(new Response('data: test\n\n'));
    }
    return request(input, init);
  });
  expect(await client.models()).toEqual({
    selected: 'gpt-6.1-sol',
    reasoning: 'medium',
    models: [
      {
        slug: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        reasoning: [
          { effort: 'low', description: 'Fast' },
          { effort: 'xhigh', description: 'Deep' },
        ],
        defaultReasoning: 'low',
      },
      { slug: 'plain', name: 'Plain' },
    ],
  });
  await expect(client.chooseReasoning('ultra')).rejects.toThrow('not available');
  await client.chooseReasoning('xhigh');
  await store.update<any>('session', (session) => ({ ...session, expires: 1 }));
  const reopened = new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher);
  await reopened.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(refreshes).toBe(1);
  expect(sent.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  expect((await reopened.models()).reasoning).toBe('xhigh');
  await reopened.chooseModel('plain');
  await reopened.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(sent.reasoning).toBeUndefined();
  await expect(reopened.chooseReasoning('low')).rejects.toThrow('not available');
  await reopened.chooseModel('gpt-6.1-sol');
  await reopened.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(sent.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
});

test('a model that rejects reasoning summaries is asked once more without them, then never again', async () => {
  const request = fetcher.getMockImplementation()!;
  const sent: { reasoning?: unknown }[] = [];
  fetcher.mockImplementation((input, init) => {
    if (String(input).endsWith('/responses')) {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      return Promise.resolve(
        body.reasoning?.summary
          ? Response.json({ error: { message: 'ChatGPT returned HTTP 400.' } }, { status: 400 })
          : new Response('data: test\n\n'),
      );
    }
    return request(input, init);
  });
  await begin();
  await client.callback(callback());
  const first = await client.responses(
    { account: 'person', request: {} },
    new AbortController().signal,
  );
  expect(first.status).toBe(200);
  await client.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(sent.map((body) => body.reasoning)).toEqual([
    { effort: 'medium', summary: 'auto' },
    { effort: 'medium' },
    { effort: 'medium' },
  ]);
});

test('a 400 that also fails without summaries leaves summaries on', async () => {
  const request = fetcher.getMockImplementation()!;
  const sent: { reasoning?: unknown }[] = [];
  let fail = true;
  fetcher.mockImplementation((input, init) => {
    if (String(input).endsWith('/responses')) {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        fail
          ? Response.json({ error: { message: 'ChatGPT returned HTTP 400.' } }, { status: 400 })
          : new Response('data: test\n\n'),
      );
    }
    return request(input, init);
  });
  await begin();
  await client.callback(callback());
  const failed = await client.responses(
    { account: 'person', request: {} },
    new AbortController().signal,
  );
  expect(failed.status).toBe(400);
  fail = false;
  await client.responses({ account: 'person', request: {} }, new AbortController().signal);
  expect(sent.map((body) => body.reasoning)).toEqual([
    { effort: 'medium', summary: 'auto' },
    { effort: 'medium' },
    { effort: 'medium', summary: 'auto' },
  ]);
});

test('provider compaction goes to the relay or the compact endpoint with the session model', async () => {
  const request = fetcher.getMockImplementation()!;
  const urls: string[] = [];
  fetcher.mockImplementation((input, init) => {
    if (String(input).endsWith('compact')) {
      urls.push(String(input));
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-6.1-sol',
        input: [{ role: 'user', content: 'hi' }],
      });
      return Promise.resolve(
        Response.json({ output: [{ type: 'compaction', encrypted_content: 'x' }] }),
      );
    }
    return request(input, init);
  });
  await begin();
  await client.callback(callback());
  const output = await client.compact(
    { account: 'person', input: [{ role: 'user', content: 'hi' }] },
    new AbortController().signal,
  );
  expect(output).toEqual([{ type: 'compaction', encrypted_content: 'x' }]);
  expect(urls).toEqual(['https://api.openai.com/v1/responses/compact']);
});

test('bug 3: a pinned model and level override the session for that request', async () => {
  const request = fetcher.getMockImplementation()!;
  const sent: { model?: string; reasoning?: unknown }[] = [];
  fetcher.mockImplementation((input, init) => {
    if (String(input).endsWith('/responses')) {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response('data: test\n\n'));
    }
    return request(input, init);
  });
  await begin();
  await client.callback(callback());
  const signal = new AbortController().signal;
  await client.responses(
    { account: 'person', request: {}, pin: { model: 'another-model', effort: 'high' } },
    signal,
  );
  await client.responses({ account: 'person', request: {}, pin: { model: 'bad model!' } }, signal);
  expect(sent.map((body) => body.model)).toEqual(['another-model', 'gpt-6.1-sol']);
  expect(sent[0].reasoning).toEqual({ effort: 'high', summary: 'auto' });
});

test('the first authorization names the app with the configured client name', async () => {
  const named = new BrowserChatGPT(
    base + 'connections/chatgpt/keys',
    new Store(crypto.randomUUID()),
    fetcher,
    undefined,
    'Example App',
  );
  const first = new URL((await named.login()).url);
  expect(first.searchParams.get('agent_name_hint')).toBe('Example App');
  await begin();
  expect(flow.searchParams.get('agent_name_hint')).toBe('Kinetik OSS');
});
