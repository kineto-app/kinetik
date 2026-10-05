import { invoke } from '@tauri-apps/api/core';
import { rpc } from '../browser/client';
import { toast } from '../ui/toast';
import { updateBanner } from '../ui/update-banner';

export interface UpdateStatus {
  enabled: boolean;
  healthConfigured: boolean;
  reportsEnabled: boolean;
  staged: string | null;
  snapshotNeeded: boolean;
  restart: boolean;
}

/** Called before the runtime can migrate or read workspace data. */
export async function restoreUpdateSnapshot() {
  const text = await invoke<string | null>('updates_restore', { complete: false });
  if (text === null) return;
  const { NativeStore } = await import('./secure-store');
  const { parseArchive } = await import('../core/archive');
  await new NativeStore().replace(
    await parseArchive(text),
    (key) => key.startsWith('connection') || key === 'deployment-config',
  );
  await invoke('updates_restore', { complete: true });
}

export function reportUpdateFirstUse(ok: boolean) {
  void invoke('updates_first_use', { ok }).catch(() => {});
}

/** The caller has loaded the local chat list and rendered the main screen. */
export async function setupNativeUpdates() {
  const status = await invoke<UpdateStatus>('updates_status');
  if (!status.enabled) return;
  // Two frames let the browser paint the rendered screen before acknowledging this boot.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  if (await invoke<boolean>('updates_ready')) toast({ text: 'Kinetik was updated', ms: 4000 });
  const { banner, action, feedback } = updateBanner();
  banner.querySelector('strong')!.textContent = 'Restart to update';
  action.hidden = true;
  feedback.textContent = 'Close and reopen Kinetik when you are ready.';
  let checking = false;
  const render = (value: UpdateStatus) => {
    banner.hidden = !value.restart;
  };
  const snapshot = async (value: UpdateStatus) => {
    if (!value.snapshotNeeded || !value.staged) return;
    // Existing export refuses while foreground or background work is running.
    const text = await rpc<string>('archiveExport');
    await invoke('updates_snapshot', { version: value.staged, text });
  };
  const inspect = async () => {
    if (checking) return;
    checking = true;
    void invoke('updates_flush').catch(() => {});
    try {
      // A previous download may only be waiting for idle workspace export.
      let value = await invoke<UpdateStatus>('updates_status');
      render(value);
      await snapshot(value);
      try {
        value = await invoke<UpdateStatus>('updates_check');
      } catch {
        value = await invoke<UpdateStatus>('updates_status');
      }
      await snapshot(value);
      render(await invoke<UpdateStatus>('updates_status'));
    } catch {
      // Offline feeds and a busy workspace leave the running bundle usable.
    } finally {
      checking = false;
    }
  };
  window.addEventListener('online', () => void inspect());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void inspect();
  });
  setInterval(
    () => {
      if (!document.hidden) void inspect();
    },
    15 * 60 * 1000,
  );
  // Retry reports independently of manifest availability and the longer check interval.
  setInterval(() => {
    if (!document.hidden) void invoke('updates_flush').catch(() => {});
  }, 60 * 1000);
  render(status);
  void inspect();
}
