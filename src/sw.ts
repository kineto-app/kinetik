/// <reference lib="webworker" />
import { sandboxCSP } from './browser/sandbox';
import { RuntimeHost } from './core/host';
import { errorText, type Conversation } from './core/types';
import { Store } from './browser/store';
import type { BackgroundProcess } from './core/background';
declare const __PRECACHE__: string[];
declare const __BUILD_ID__: string;
const sw = globalThis as unknown as ServiceWorkerGlobalScope;
const scope = new URL(sw.registration.scope);
const cachePrefix = 'kinetik-app:' + scope.pathname + ':';
const cacheName = cachePrefix + __BUILD_ID__;
const store = new Store();
const updateKey = 'app-update:' + scope.pathname;
const operationLock = 'kinetik-runtime:' + scope.pathname;
const host = new RuntimeHost(store, scope, () => {
  void sw.clients
    .matchAll()
    .then((clients) => clients.forEach((client) => client.postMessage({ type: 'changed' })));
});
const initialize = () => host.initialize();
async function operation(work: () => Promise<void>) {
  await navigator.locks.request(operationLock, { mode: 'shared' }, async () => {
    const target = await store.get<string>(updateKey);
    if (target && target !== __BUILD_ID__) throw new Error('App updated. Reload to continue.');
    await initialize();
    await work();
  });
}
async function activateUpdate() {
  await navigator.locks.request(operationLock, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Work is still running. Try Update again when it finishes.');
    const conversations = await store.entries<Conversation>('conversation:');
    const jobs = await store.entries<BackgroundProcess>('background:');
    if (
      conversations.some(([, c]) => ['running', 'queued'].includes(c.status)) ||
      jobs.some(([, job]) => job.state === 'running' || !job.delivered)
    )
      throw new Error('Work is still running. Try Update again when it finishes.');
    // Older workers cannot start new work in the gap before activation.
    const previous = await store.get<string>(updateKey);
    await store.put(updateKey, __BUILD_ID__);
    try {
      await sw.skipWaiting();
    } catch (error) {
      await store.put(updateKey, previous ?? '');
      throw error;
    }
  });
}
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
      await store.put(updateKey, __BUILD_ID__);
      await initialize();
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
  if (relative === 'config.json' || relative.startsWith('connections/')) return;
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
      if (cached) {
        if (relative === 'app-sandbox.html') {
          const headers = new Headers(cached.headers);
          headers.set('Content-Security-Policy', sandboxCSP);
          return new Response(cached.body, { status: cached.status, headers });
        }
        return cached;
      }
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
  if (event.data?.op === 'version' || event.data?.op === 'activateUpdate') {
    event.waitUntil(
      (async () => {
        try {
          if (event.data.op === 'activateUpdate') await activateUpdate();
          port.postMessage({ ok: true, result: __BUILD_ID__ });
        } catch (error) {
          port.postMessage({ ok: false, error: errorText(error) });
        }
      })(),
    );
    return;
  }
  event.waitUntil(
    operation(() => host.handle(event.data, (message) => port.postMessage(message))).catch(
      (error) => port.postMessage({ ok: false, error: errorText(error) }),
    ),
  );
});
// Push providers deliver {id, name, text}; IDs deduplicate redelivery. No token lives here.
sw.addEventListener('push', (event) => {
  event.waitUntil(
    operation(async () => {
      const value = event.data?.json();
      if (value)
        await host.runtime.automations.emit(
          string(value.name),
          string(value.text),
          string(value.id),
        );
      await sw.registration.showNotification('Kinetik', {
        body: 'Background event received. Open Kinetik to review work.',
        tag: 'kinetik-event',
      });
      await host.runtime.automations.tick();
      await host.runtime.background.drain();
    }),
  );
});
sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(sw.clients.openWindow(scope.href));
});
for (const type of ['sync', 'periodicsync']) {
  sw.addEventListener(type, ((event: ExtendableEvent) => {
    event.waitUntil(
      operation(async () => {
        await host.runtime.automations.tick();
        await host.runtime.background.drain();
      }),
    );
  }) as EventListener);
}
