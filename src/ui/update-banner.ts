/** Keep the shared update control above the current modal. */
export function updateBanner() {
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
  return { banner, action, feedback };
}
