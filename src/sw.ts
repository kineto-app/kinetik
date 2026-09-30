/// <reference lib="webworker" />
import { Runtime } from './core/runtime';
import { errorText } from './core/types';
declare const __PRECACHE__: string[];
declare const __BUILD_ID__: string;
const sw = globalThis as unknown as ServiceWorkerGlobalScope;
const scope = new URL(sw.registration.scope);
const cachePrefix = 'kinetik-app:' + scope.pathname + ':';
const cacheName = cachePrefix + __BUILD_ID__;
const runtime = new Runtime(undefined, () => {
  void sw.clients
    .matchAll()
    .then((clients) => clients.forEach((client) => client.postMessage({ type: 'changed' })));
});
const initialized = runtime.recover();
sw.addEventListener('install', (event) => {
  // Waiting updates do not interrupt in-progress turns. First install activates naturally.
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.addAll(__PRECACHE__.map((path) => new URL(path, scope).href))),
  );
});
sw.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      await initialized;
      for (const name of await caches.keys())
        if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
      await sw.clients.claim();
    })(),
  ),
);
sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== scope.origin ||
    !url.pathname.startsWith(scope.pathname)
  )
    return;
  const relative = url.pathname.slice(scope.pathname.length);
  // Plugin sources and API requests must never be trapped in the app-shell cache.
  if (!__PRECACHE__.includes(relative) && event.request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      if (relative.startsWith('plugins/')) {
        try {
          return await fetch(event.request);
        } catch {
          /* Built-in examples are also available offline. */
        }
      }
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const page = await cache.match(new URL('index.html', scope).href);
        if (page) return page;
      }
      return fetch(event.request);
    })(),
  );
});
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string.');
  return value;
}
sw.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port || !event.source || !('url' in event.source)) return;
  const source = new URL(event.source.url);
  if (source.origin !== scope.origin || !source.pathname.startsWith(scope.pathname)) return;
  event.waitUntil(
    (async () => {
      let followup: string | undefined;
      try {
        await initialized;
        const data = event.data as Record<string, unknown>;
        let result: unknown;
        switch (data.op) {
          case 'state':
            result = {
              conversations: (await runtime.conversations()).map((c) => ({
                ...c,
                plugins: undefined,
              })),
              plugins: (await runtime.plugins.list()).map((p) => ({
                manifest: p.manifest,
                enabledAt: p.enabledAt,
                source: p.source,
                digest: p.digest,
              })),
            };
            break;
          case 'create':
            result = await runtime.create();
            break;
          case 'submit':
            followup = string(data.id);
            await runtime.submit(followup, string(data.text));
            break;
          case 'stop':
            await runtime.stop(string(data.id));
            break;
          case 'resolve':
            followup = string(data.id);
            await runtime.resolve(followup, data.retry === true);
            break;
          case 'install': {
            const settings = JSON.parse(string(data.settings ?? '{}')) as Record<string, unknown>;
            if (
              !settings ||
              Array.isArray(settings) ||
              typeof settings !== 'object' ||
              Object.values(settings).some((v) => typeof v !== 'string')
            )
              throw new Error('Plugin settings must be a JSON object of strings.');
            await runtime.plugins.install(string(data.source), settings as Record<string, string>);
            break;
          }
          case 'enable':
            await runtime.plugins.enable(string(data.id), data.enabled === true);
            break;
          case 'update': {
            const plugin = (await runtime.plugins.list()).find((p) => p.manifest.id === data.id);
            if (!plugin) throw new Error('Plugin not found.');
            await runtime.plugins.install(plugin.source, plugin.settings, plugin.manifest.id);
            break;
          }
          case 'import':
            if (!(data.bytes instanceof Uint8Array)) throw new Error('Invalid file bytes.');
            await runtime.importFile(string(data.name), data.bytes);
            break;
          case 'export':
            result = await runtime.exportFile(string(data.path));
            break;
          default:
            throw new Error('Unknown request.');
        }
        port.postMessage({ ok: true, result });
        if (followup) await runtime.run(followup);
        if (data.op === 'state')
          await Promise.all(
            (await runtime.conversations())
              .filter((c) => c.status === 'queued' || c.status === 'running')
              .map((c) => runtime.run(c.id)),
          );
      } catch (error) {
        port.postMessage({ ok: false, error: errorText(error) });
      }
    })(),
  );
});
