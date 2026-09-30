import { check, download, notifyAppReady } from 'tauri-plugin-hot-update-api';
import { updateBanner } from '../ui/update-banner';

/** Checks are passive; only the user's Update action stages a bundle for the next launch. */
export async function setupNativeUpdates() {
  const { banner, action, feedback } = updateBanner();
  // A working UI commits this boot independently of network availability and login.
  await notifyAppReady();
  let checking = false;
  let staging = false;
  const inspect = async () => {
    if (checking || staging) return;
    checking = true;
    try {
      const result = await check();
      banner.hidden = !['available', 'alreadyStaged', 'shellTooOld'].includes(result.status);
      if (result.status === 'alreadyStaged') {
        feedback.textContent = 'Update ready. Close and reopen Kinetik to apply.';
        action.hidden = true;
      } else if (result.status === 'shellTooOld') {
        feedback.textContent = 'A new app version is required for this update.';
        action.hidden = true;
      }
    } catch {
      // Disabled update channels and offline checks leave the installed app available.
    } finally {
      checking = false;
    }
  };
  action.onclick = () => {
    if (staging) return;
    staging = true;
    action.disabled = true;
    feedback.textContent = 'Downloading update…';
    void download()
      .then((result) => {
        if (result.status === 'staged' || result.status === 'alreadyStaged') {
          feedback.textContent = 'Update ready. Close and reopen Kinetik to apply.';
          action.hidden = true;
        } else feedback.textContent = 'This update is no longer available.';
      })
      .catch(() => {
        feedback.textContent = 'Could not download the update. Try again.';
      })
      .finally(() => {
        staging = false;
        action.disabled = false;
      });
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
  void inspect();
}
