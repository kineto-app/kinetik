import type { Store } from '../browser/store';
import type { BackgroundProcess } from './background';
import type { Conversation, InstalledPlugin } from './types';

const keepFinishedJobs = 7 * 24 * 3600 * 1000;
const finished = new Set(['completed', 'interrupted', 'cancelled']);

/** Deletes records that no conversation, job or widget refers to any more. */
export async function sweep(store: Store, now = Date.now()) {
  const used = new Set<string>();
  const usePlugins = (plugins?: InstalledPlugin[]) =>
    plugins?.forEach((plugin) => used.add('plugin-code:' + plugin.digest));
  for (const [, c] of await store.entries<Conversation>('conversation:')) {
    used.add(`model-archive:${c.id}:${c.compactions ?? 0}`);
    usePlugins(c.plugins);
    for (const file of c.attachments ?? []) {
      used.add('attachment-bytes:' + file.id);
      used.add('attachment-preview:' + file.id);
    }
    for (const m of c.messages) {
      if (m.file?.snapshotId) used.add('shared-file:' + m.file.snapshotId);
      for (const file of m.attachments ?? []) used.add('attachment-preview:' + file.id);
    }
  }
  const stale: string[] = [];
  for (const [key, job] of await store.entries<BackgroundProcess>('background:')) {
    if (job.delivered && finished.has(job.state) && (job.startedAt ?? 0) < now - keepFinishedJobs)
      stale.push(key);
    else usePlugins(job.plugins);
  }
  for (const [, app] of await store.entries<{ plugins?: InstalledPlugin[] }>('app:'))
    usePlugins(app.plugins);
  for (const [key, call] of await store.entries<{ state: string }>('app-call:'))
    if (call.state !== 'pending') stale.push(key);
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
    ...(await store.keys(`model-input:${id}:`)),
    ...(await store.keys(`model-archive:${id}:`)),
  ];
  const c = await store.get<Conversation>('conversation:' + id);
  for (const file of c?.attachments ?? [])
    keys.push('attachment-bytes:' + file.id, 'attachment-preview:' + file.id);
  for (const m of c?.messages ?? []) {
    if (m.file?.snapshotId) keys.push('shared-file:' + m.file.snapshotId);
    for (const file of m.attachments ?? []) keys.push('attachment-preview:' + file.id);
  }
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
