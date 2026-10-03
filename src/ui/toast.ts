import { byId } from './dom';
import { icon } from './icons';

export interface Toast {
  text: string;
  action?: { label: string; run: () => void };
  /** Runs when the toast leaves without its action: timed out or dismissed. */
  done?: () => void;
  key?: string;
  ms?: number;
}
/** A small floating island at the top of the chat. A toast with the same key replaces the last. */
export function toast({ text, action, done, key, ms = 6000 }: Toast) {
  const area = byId('toasts');
  if (key)
    area.querySelector<HTMLElement & { leave?: () => void }>(`[data-key="${key}"]`)?.leave?.();
  const node = document.createElement('div') as HTMLDivElement & { leave?: () => void };
  node.className = 'toast';
  if (key) node.dataset.key = key;
  const label = document.createElement('span');
  label.textContent = text;
  node.append(label);
  let finished = false;
  const leave = (acted = false) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    node.remove();
    if (!acted) done?.();
  };
  node.leave = leave;
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.onclick = () => {
      leave(true);
      action.run();
    };
    node.append(button);
  }
  const close = document.createElement('button');
  close.className = 'icon-button toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = icon('close');
  close.onclick = () => leave();
  node.append(close);
  area.append(node);
  const timer = setTimeout(() => leave(), ms);
  return leave;
}
