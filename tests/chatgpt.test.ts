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
      return Response.json({ models: [{ slug: 'available-model', visibility: 'list' }] });
    if (String(url).endsWith('/responses')) {
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.model).toBe('available-model');
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
test('keeps tokens only in memory, clears legacy storage, and signs out after worker restart', async () => {
  await store.put('session', { access: 'placeholder-old-access', refresh: 'placeholder-old-refresh' });
  await begin();
  const host = flow.searchParams.get('ext_agent_host_id');
  await client.callback(callback());
  expect(await client.status()).toEqual({
    connected: true,
    model: 'available-model',
    account: 'person',
  });
  expect(JSON.stringify(await store.entries(''))).not.toMatch(/placeholder-access-one|placeholder-refresh-one|old-saved/);
  expect(
    await new BrowserChatGPT(base + 'connections/chatgpt/keys', store, fetcher).status(),
  ).toEqual({ connected: false, model: '', account: '' });
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
    [1, 2].map(() =>
      client.responses(
        { account: 'person', request: { store: true, model: 'wrong' } },
        new AbortController().signal,
      ),
    ),
  );
  expect(refreshes).toBe(1);
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
