/// <reference lib="webworker" />
import { sandboxCSP } from './browser/sandbox';
import { Runtime } from './core/runtime';
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
let runtime: Runtime;
let initialized: Promise<void> | undefined;
function initialize() {
  return (initialized ??= (async () => {
    runtime = new Runtime(store, () => {
      void sw.clients
        .matchAll()
        .then((clients) => clients.forEach((client) => client.postMessage({ type: 'changed' })));
    });
    await runtime.recover();
  })());
}
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
    operation(async () => {
      let followup: string | undefined;
      try {
        const data = event.data as Record<string, unknown>;
        let result: unknown;
        switch (data.op) {
          case 'state':
            result = {
              automations: await runtime.automations.list(),
              background: (await store.entries<BackgroundProcess>('background:'))
                .filter(([, job]) => job.state === 'running')
                .map(([, { id, conversationId, tool }]) => ({ id, conversationId, tool })),
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
          case 'tick':
            break;
          case 'automationCreate':
            result = await runtime.automations.create(data.input as Record<string, unknown>);
            break;
          case 'automationStatus':
            await runtime.automations.setStatus(
              string(data.id),
              data.status as 'active' | 'paused' | 'completed',
            );
            break;
          case 'automationRemove':
            await runtime.automations.remove(string(data.id));
            break;
          case 'event':
            await runtime.automations.emit(
              string(data.name),
              string(data.text),
              data.id as string | undefined,
            );
            break;
          case 'appCall':
            if (!data.input || typeof data.input !== 'object' || Array.isArray(data.input))
              throw new Error('Invalid tool input.');
            result = await runtime.appCall(
              string(data.id),
              string(data.name),
              data.input as Record<string, unknown>,
            );
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
          case 'files':
            result = await runtime.files();
            break;
          case 'export':
            result = await runtime.exportFile(string(data.path));
            break;
          default:
            throw new Error('Unknown request.');
        }
        port.postMessage({ ok: true, result });
        if (followup) await runtime.run(followup);
        if (['tick', 'automationCreate', 'automationStatus', 'event'].includes(data.op as string))
          await runtime.automations.tick();
        if (data.op === 'state')
          await Promise.all(
            (await runtime.conversations())
              .filter((c) => c.status === 'queued' || c.status === 'running')
              .map((c) => runtime.run(c.id)),
          );
      } catch (error) {
        port.postMessage({ ok: false, error: errorText(error) });
      } finally {
        await runtime.background.drain();
      }
    }).catch((error) => port.postMessage({ ok: false, error: errorText(error) })),
  );
});

// Push providers deliver {id, name, text}; IDs deduplicate redelivery. No token lives here.
sw.addEventListener('push', (event) => {
  event.waitUntil(
    operation(async () => {
      const value = event.data?.json();
      if (value)
        await runtime.automations.emit(string(value.name), string(value.text), string(value.id));
      await sw.registration.showNotification('Kinetik', {
        body: 'Background event received. Open Kinetik to review work.',
        tag: 'kinetik-event',
      });
      await runtime.automations.tick();
      await runtime.background.drain();
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
        await runtime.automations.tick();
        await runtime.background.drain();
      }),
    );
  }) as EventListener);
}
