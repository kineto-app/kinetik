import { byId } from './dom';
import { icon } from './icons';

/** The newest part of a reasoning summary: its bold heading and the text after it. */
export function latestThought(text: string) {
  const headings = [...text.matchAll(/\*\*(.+?)\*\*/g)];
  const last = headings.at(-1);
  const body = (last ? text.slice(last.index! + last[0].length) : text).trim();
  return {
    heading: last?.[1].trim() || 'Thinking',
    body: body.length > 280 ? '…' + body.slice(-280).replace(/^\S*\s/, '') : body,
  };
}
export function renderThought(thought: { heading: string; body: string } | undefined) {
  const timeline = byId('timeline');
  let note = timeline.querySelector<HTMLElement>('[data-thinking]');
  if (!thought) return note?.remove();
  if (!note) {
    note = document.createElement('div');
    note.className = 'thinking-note';
    note.dataset.thinking = 'true';
    note.innerHTML = `<div class="thinking-heading">${icon('spark')}<span></span></div><p></p>`;
    timeline.insertBefore(note, timeline.querySelector('[data-draft]'));
    if (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 160)
      timeline.scrollTop = timeline.scrollHeight;
  }
  note.querySelector('span')!.textContent = thought.heading;
  note.querySelector('p')!.textContent = thought.body;
}
