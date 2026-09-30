import { afterEach, expect, test, vi } from 'vitest';

const { nativeFetch, browserFetch } = vi.hoisted(() => ({
  nativeFetch: vi.fn(),
  browserFetch: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: nativeFetch }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.resetModules();
});

async function setup() {
  vi.stubGlobal('fetch', browserFetch);
  vi.stubGlobal('location', { origin: 'https://tauri.localhost' });
  vi.stubGlobal('document', { baseURI: 'https://tauri.localhost/' });
  nativeFetch.mockResolvedValue(new Response(null, { status: 204 }));
  return (await import('../src/platform/native-fetch')).platformFetch;
}

test('native upload omits the synthetic WebView origin and preserves bytes and cancellation', async () => {
  const fetch = await setup();
  const body = new Uint8Array([0, 255, 42]);
  const signal = new AbortController().signal;
  await fetch('https://files.example/upload', {
    method: 'PUT',
    body,
    signal,
    redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const options = nativeFetch.mock.calls[0][1];
  expect(options.headers.get('Origin')).toBe('');
  expect(options.headers.get('Content-Type')).toBe('application/octet-stream');
  expect(options.body).toBe(body);
  expect(options.signal).toBe(signal);
  expect(options.maxRedirections).toBe(0);
  expect(browserFetch).not.toHaveBeenCalled();
});

test('native transport preserves request headers and explicit origins', async () => {
  const fetch = await setup();
  const request = new Request('https://service.example/api', {
    headers: { Authorization: 'Bearer test', Origin: 'https://explicit.example' },
  });
  await fetch(request);
  const headers = nativeFetch.mock.calls[0][1].headers;
  expect(headers.get('Authorization')).toBe('Bearer test');
  expect(headers.get('Origin')).toBe('https://explicit.example');
});

test('local assets use WebView fetch unchanged', async () => {
  const fetch = await setup();
  await fetch('plugins/charms/plugin.json');
  expect(browserFetch).toHaveBeenCalledWith('plugins/charms/plugin.json', undefined);
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('native transport still rejects redirects when required', async () => {
  const fetch = await setup();
  nativeFetch.mockResolvedValue(new Response(null, { status: 302 }));
  await expect(fetch('https://files.example/upload', { redirect: 'error' })).rejects.toThrow(
    'Unexpected redirect',
  );
});
