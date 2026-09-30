interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export type InstallPlatform = 'ios' | 'mac-safari' | 'chromium' | 'other';

export function setupInstallation(changed: () => void) {
  const mode = matchMedia('(display-mode: standalone)');
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  const ua = navigator.userAgent;
  const platform: InstallPlatform =
    /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? 'ios'
      : /Mac/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)
        ? 'mac-safari'
        : /Chrome|Chromium|Edg/.test(ua)
          ? 'chromium'
          : 'other';
  let pending: InstallPrompt | undefined;
  let accepted = false;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    pending = event as InstallPrompt;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    accepted = true;
    pending = undefined;
    changed();
  });
  mode.addEventListener('change', changed);
  window.addEventListener('pageshow', changed);
  return {
    platform,
    get standalone() {
      return mode.matches || navigatorWithStandalone.standalone === true;
    },
    get available() {
      return Boolean(pending);
    },
    get accepted() {
      return accepted;
    },
    async prompt() {
      const event = pending;
      if (!event) return;
      pending = undefined;
      await event.prompt();
      accepted = (await event.userChoice).outcome === 'accepted';
      changed();
    },
  };
}
