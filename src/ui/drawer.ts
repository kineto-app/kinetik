import { byId } from './dom';

const narrow = matchMedia('(max-width: 700px)');
export function closeDrawer(restoreFocus = true) {
  const wasOpen = byId('sidebar').classList.contains('open');
  byId('sidebar').classList.remove('open');
  byId('sidebar').removeAttribute('role');
  byId('sidebar').removeAttribute('aria-modal');
  byId('sidebar').inert = narrow.matches;
  byId('main').inert = false;
  byId('drawer-scrim').hidden = true;
  byId('menu').setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreFocus) byId('menu').focus();
}
export function openDrawer() {
  byId('sidebar').inert = false;
  byId('sidebar').classList.add('open');
  byId('sidebar').setAttribute('role', 'dialog');
  byId('sidebar').setAttribute('aria-modal', 'true');
  byId('main').inert = true;
  byId('drawer-scrim').hidden = false;
  byId('menu').setAttribute('aria-expanded', 'true');
  byId('menu-close').focus();
}

/** The chat list: a column on wide screens, a drawer with a focus trap on narrow ones. */
export function setupDrawer() {
  narrow.addEventListener('change', () => closeDrawer(false));
  closeDrawer(false);
  byId('menu').onclick = openDrawer;
  byId('menu-close').onclick = () => closeDrawer();
  byId('drawer-scrim').onclick = () => closeDrawer();
  byId('sidebar').addEventListener('keydown', (event) => {
    if (!narrow.matches || !byId('sidebar').classList.contains('open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
    }
    if (event.key === 'Tab') {
      const items = [
        ...byId('sidebar').querySelectorAll<HTMLElement>('button:not([disabled]),select'),
      ].filter((item) => item.getClientRects().length > 0);
      const first = items[0],
        last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}
