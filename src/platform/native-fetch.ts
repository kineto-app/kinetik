import { fetch as nativeFetch } from '@tauri-apps/plugin-http';

const browserFetch = globalThis.fetch.bind(globalThis);

export async function platformFetch(input: RequestInfo | URL, init?: RequestInit) {
  const value = input instanceof Request ? input.url : String(input);
  const url = new URL(value, document.baseURI);
  // Windows Tauri IPC uses this virtual host. Sending it through native HTTP
  // would recursively invoke the HTTP plugin before the original IPC can finish.
  if (
    url.origin === location.origin ||
    url.hostname === 'ipc.localhost' ||
    !['http:', 'https:'].includes(url.protocol)
  )
    return browserFetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  // Native HTTP has no browser origin. The plugin's unsafe-headers feature interprets an
  // empty Origin as omission; otherwise it adds the WebView origin, rejected by CORS servers.
  if (!headers.has('Origin')) headers.set('Origin', '');
  const response = await nativeFetch(input, {
    ...init,
    headers,
    maxRedirections: init?.redirect === 'error' ? 0 : 5,
  });
  if (init?.redirect === 'error' && response.status >= 300 && response.status < 400)
    throw new Error('Unexpected redirect.');
  return response;
}
