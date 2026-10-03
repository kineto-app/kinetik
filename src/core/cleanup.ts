import type { Store } from '../browser/store';
import type { BackgroundProcess } from './background';
import { traceKey } from './trace';
import type { Conversation, InstalledPlugin } from './types';

const day = 24 * 3600 * 1000;
const keepFinishedJobs = 7 * day;
const finished = new Set(['completed', 'interrupted', 'cancelled']);
const sweptKey = 'meta:swept-at';

/** Files stored for a conversation: its staged attachments and what its messages show. */
const fileKeys = (c: Conversation) => [
  ...(c.attachments ?? []).flatMap((f) => [
    'attachment-bytes:' + f.id,
    'attachment-preview:' + f.id,
  ]),
  ...c.messages.flatMap((m) => [
    ...(m.file?.snapshotId ? ['shared-file:' + m.file.snapshotId] : []),
    ...(m.attachments ?? []).map((f) => 'attachment-preview:' + f.id),
  ]),
];

/** Sweeps at most once a day, so a cold start rarely reads every record. */
export async function sweepDaily(store: Store, now = Date.now()) {
  if (((await store.get<number>(sweptKey)) ?? 0) > now - day) return;
  await sweep(store, now);
  await store.put(sweptKey, now);
}

/** Deletes records that no conversation, job or widget refers to any more. */
export async function sweep(store: Store, now = Date.now()) {
  const used = new Set<string>();
  const chats = new Set<string>();
  const usePlugins = (plugins?: InstalledPlugin[]) =>
    plugins?.forEach((plugin) => used.add('plugin-code:' + plugin.digest));
  for (const [, c] of await store.entries<Conversation>('conversation:')) {
    chats.add(c.id);
    used.add(`model-archive:${c.id}:${c.compactions ?? 0}`);
    usePlugins(c.plugins);
    fileKeys(c).forEach((key) => used.add(key));
  }
  const stale: string[] = [];
  for (const [key, job] of await store.entries<BackgroundProcess>('background:')) {
    if (job.delivered && finished.has(job.state) && (job.startedAt ?? 0) < now - keepFinishedJobs)
      stale.push(key);
    else usePlugins(job.plugins);
  }
  for (const [key, app] of await store.entries<{
    conversationId?: string;
    plugins?: InstalledPlugin[];
  }>('app:'))
    if (app.conversationId && !chats.has(app.conversationId)) stale.push(key);
    else usePlugins(app.plugins);
  for (const [key, call] of await store.entries<{ state: string }>('app-call:'))
    if (call.state !== 'pending') stale.push(key);
  for (const key of await store.keys('trace:'))
    if (!chats.has(key.slice('trace:'.length))) stale.push(key);
  for (const prefix of [
    'model-archive:',
    'shared-file:',
    'attachment-preview:',
    'attachment-bytes:',
    'plugin-code:',
  ])
    for (const key of await store.keys(prefix)) if (!used.has(key)) stale.push(key);
  const installed = (await store.get<InstalledPlugin[]>('plugins')) ?? [];
  for (const key of await store.keys('skills:'))
    if (!installed.some((p) => key.startsWith(`skills:${p.manifest.id}:${p.digest}:`)))
      stale.push(key);
  if (stale.length) await store.updateMany([], () => stale.map((key) => [key, undefined]));
}

/** Everything stored for one conversation, including the files only its messages refer to. */
export async function conversationKeys(store: Store, id: string) {
  const keys = [
    'conversation:' + id,
    traceKey(id),
    ...(await store.keys(`model-input:${id}:`)),
    ...(await store.keys(`model-archive:${id}:`)),
  ];
  const c = await store.get<Conversation>('conversation:' + id);
  if (c) keys.push(...fileKeys(c));
  const apps = new Set<string>();
  for (const [key, app] of await store.entries<{ conversationId?: string }>('app:'))
    if (app.conversationId === id) {
      keys.push(key);
      apps.add(key.slice('app:'.length));
    }
  for (const [key, call] of await store.entries<{ conversationId?: string; appId?: string }>(
    'app-call:',
  ))
    if (call.conversationId === id || apps.has(call.appId ?? '')) keys.push(key);
  for (const [key, job] of await store.entries<{ conversationId?: string }>('background:'))
    if (job.conversationId === id) keys.push(key);
  return keys;
}
