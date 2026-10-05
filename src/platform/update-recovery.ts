import { invoke } from '@tauri-apps/api/core';
import type { UpdateStatus } from './updates';

/** The embedded UI can recover updates without creating a runtime or opening IndexedDB. */
export function showUpdateRecovery(initial: UpdateStatus) {
  if (document.getElementById('update-recovery')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'update-recovery';
  dialog.setAttribute('aria-labelledby', 'update-recovery-title');
  dialog.setAttribute('aria-describedby', 'update-recovery-reason');
  dialog.innerHTML = `<div class="dialog-head"><div><h2 id="update-recovery-title">Kinetik recovery</h2></div></div>
    <p id="update-recovery-reason"></p>
    <p class="muted">Your workspace stays closed during recovery.</p>
    <p id="update-recovery-status" role="status" aria-live="polite"></p>
    <p id="update-recovery-error" class="feedback" role="alert"></p>
    <button type="button" class="primary">Check for update</button>`;
  const reason = dialog.querySelector<HTMLElement>('#update-recovery-reason')!;
  const progress = dialog.querySelector<HTMLElement>('#update-recovery-status')!;
  const error = dialog.querySelector<HTMLElement>('#update-recovery-error')!;
  const check = dialog.querySelector('button')!;
  let status = initial;
  let checking = false;
  const render = () => {
    reason.textContent = status.recovery ?? initial.recovery ?? '';
    check.hidden = !status.enabled;
    progress.textContent =
      status.restart && status.staged
        ? `Update ${status.staged} is ready. Close Kinetik completely, then reopen it to recover your workspace.`
        : status.enabled
          ? 'No compatible update is ready yet. Kinetik will keep checking while this screen is open.'
          : '';
  };
  const inspect = async () => {
    if (checking || !status.enabled) return;
    checking = true;
    check.disabled = true;
    error.textContent = '';
    if (!status.restart) progress.textContent = 'Checking for a compatible update…';
    try {
      status = await invoke<UpdateStatus>('updates_check');
      render();
    } catch {
      render();
      error.textContent = 'Could not check for updates. Check your connection and try again.';
    } finally {
      checking = false;
      check.disabled = false;
    }
  };
  check.onclick = () => void inspect();
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  document.body.append(dialog);
  render();
  dialog.showModal();
  window.addEventListener('online', () => void inspect());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void inspect();
  });
  setInterval(() => {
    if (!document.hidden) void inspect();
  }, 60_000);
  void inspect();
}
