import type { Conversation } from '../core/types';
import { taskLabel } from './task-labels';

/** Keep tool receipts collapsed together, without moving embedded apps or files. */
export function renderToolActivity(timeline: HTMLElement, conversation?: Conversation) {
  if (!conversation) return;
  let turn = 'start';
  const groups = new Map<string, { count: number; label: string }>();
  const existing = () => [...timeline.querySelectorAll<HTMLDetailsElement>('.tool-group')];
  const ensure = (id: string, before: Element | null) => {
    let group = existing().find((node) => node.dataset.turn === id);
    if (!group) {
      group = document.createElement('details');
      group.className = 'tool-group';
      group.dataset.turn = id;
      group.innerHTML =
        '<summary><span class="tool-group-mark" aria-hidden="true">✓</span><span class="tool-group-label"></span></summary><div class="tool-group-steps"></div>';
      timeline.insertBefore(group, before);
    }
    return group;
  };
  for (const item of conversation.messages) {
    if (
      item.visibility === 'internal' ||
      item.source === 'background' ||
      item.tool?.startsWith('background ·')
    )
      continue;
    if (item.role === 'user' || item.role === 'assistant') turn = item.id;
    if (item.role !== 'tool') continue;
    const article = [...timeline.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (node) => node.dataset.messageId === item.id,
    );
    if (!article) continue;
    const group = ensure(turn, article);
    const receipt = article.querySelector('.tool-details');
    if (receipt) group.querySelector('.tool-group-steps')!.append(receipt);
    article.hidden = !item.app && !item.file;
    groups.set(turn, {
      count: (groups.get(turn)?.count ?? 0) + 1,
      label: taskLabel(item.tool ?? '', true),
    });
  }
  const pending =
    conversation.status === 'running' &&
    conversation.turn !== 'background' &&
    conversation.call?.state === 'pending' &&
    conversation.call.name !== 'background';
  if (pending) ensure(turn, timeline.querySelector('[data-draft]'));
  for (const group of existing()) {
    const current = pending && group.dataset.turn === turn;
    const completed = groups.get(group.dataset.turn!);
    if (!completed && !current) {
      group.remove();
      continue;
    }
    group.dataset.running = String(Boolean(current));
    group.querySelector('.tool-group-mark')!.textContent = current ? '·' : '✓';
    group.querySelector('.tool-group-label')!.textContent = current
      ? taskLabel(conversation.call!.name)
      : completed!.label + (completed!.count > 1 ? ` · ${completed!.count} steps` : '');
  }
}
