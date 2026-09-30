import { workerRPC } from './client';

/** A downloaded worker waits for an explicit click; checking never activates it. */
export async function setupUpdates(registration: ServiceWorkerRegistration) {
  const banner = document.getElementById('app-update')!;
  const action = document.getElementById('app-update-apply') as HTMLButtonElement;
  const feedback = document.getElementById('app-update-feedback')!;
  const home = document.createComment('update banner');
  banner.before(home);
  const modalSelector = 'dialog:modal, [role="dialog"][aria-modal="true"]';
  let surfaces = [...document.querySelectorAll<HTMLElement>(modalSelector)];
  const placeBanner = (changes: MutationRecord[] = []) => {
    // A banner behind a modal is inert. Keep the same control inside the topmost
    // open screen, preserving its progress/error state as screens open and close.
    for (const { target } of changes) {
      if (!(target instanceof HTMLElement)) continue;
      surfaces = surfaces.filter((surface) => surface !== target);
      if (target.matches(modalSelector)) surfaces.push(target);
    }
    surfaces = surfaces.filter((surface) => surface.isConnected && surface.matches(modalSelector));
    const surface = surfaces.at(-1);
    if (surface) {
      if (banner.parentElement !== surface) surface.prepend(banner);
    } else if (banner.previousSibling !== home) home.after(banner);
  };
  new MutationObserver(placeBanner).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'aria-modal'],
  });
  placeBanner();
  let applying = false;
  let controlled = Boolean(navigator.serviceWorker.controller);
  const render = () => {
    banner.hidden = !registration.waiting;
  };
  const watch = () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', render);
    render();
  };
  registration.addEventListener('updatefound', watch);
  watch();
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled) location.reload();
    else controlled = true;
  });
  action.onclick = () => {
    if (applying || !registration.waiting) return;
    applying = true;
    action.disabled = true;
    feedback.textContent = 'Updating…';
    void workerRPC(registration.waiting, 'activateUpdate').catch((error) => {
      feedback.textContent = error instanceof Error ? error.message : String(error);
      applying = false;
      action.disabled = false;
    });
  };
  let checking: Promise<void> | undefined;
  const check = () =>
    (checking ??= (async () => {
      try {
        await registration.update();
        const worker = registration.installing;
        if (worker)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, 30000);
            function done() {
              clearTimeout(timer);
              worker!.removeEventListener('statechange', changed);
              resolve();
            }
            function changed() {
              if (['installed', 'activated', 'redundant'].includes(worker!.state)) done();
            }
            worker.addEventListener('statechange', changed);
            changed();
          });
      } catch {
        /* An offline app keeps its current version. */
      } finally {
        render();
        checking = undefined;
      }
    })());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.addEventListener('online', () => {
    void check();
  });
  setInterval(
    () => {
      if (document.visibilityState === 'visible') void check();
    },
    15 * 60 * 1000,
  );
  await check();
}
