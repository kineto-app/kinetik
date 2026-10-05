import { invoke } from '@tauri-apps/api/core';
import { Store } from '../browser/store';
import { exportArchive } from '../core/archive';
import type { Conversation } from '../core/types';
import type { BackgroundProcess } from '../core/background';

/** Shared by every workspace write and by snapshot export/acknowledgement. */
export function withWorkspaceSnapshot<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks.request('kinetik-update-workspace', work);
}
export async function writeWorkspace<T>(work: () => Promise<T>): Promise<T> {
  let refresh = false;
  try {
    return await withWorkspaceSnapshot(async () => {
      // Durable invalidation must finish before IndexedDB can change.
      refresh = await invoke<boolean>('updates_workspace_write');
      return work();
    });
  } finally {
    if (refresh) window.dispatchEvent(new Event('kinetik-workspace-changed'));
  }
}
export async function restoreWorkspace(records: [string, unknown][], backupName: string) {
  await withWorkspaceSnapshot(async () => {
    await invoke('updates_workspace_write');
    const live = new Store();
    const backup = new Store(backupName);
    const complete = 'kinetik-update:copy-complete';
    if (!(await backup.get(complete))) {
      // Structured clone preserves unknown records, typed arrays, dates and future schemas.
      await backup.replace([...(await live.entries('')), [complete, true]], () => false);
    }
    await live.replace(
      records,
      (key) => key.startsWith('connection') || key === 'deployment-config',
    );
    await invoke('updates_restore', { complete: true });
  });
}

/** Reads only: runtime initialization and migrations must never run under this lock. */
export async function captureUpdateSnapshot(version: string) {
  await withWorkspaceSnapshot(async () => {
    const store = new Store();
    const busy =
      (await store.entries<Conversation>('conversation:')).some(([, chat]) =>
        ['running', 'queued', 'waiting'].includes(chat.status),
      ) ||
      (await store.entries<BackgroundProcess>('background:')).some(([, job]) =>
        ['running', 'waiting'].includes(job.state),
      );
    if (busy) throw new Error('Wait for current work to finish before transferring data.');
    const text = await exportArchive(store);
    await invoke('updates_snapshot', { version, text });
  });
}
