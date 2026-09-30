import type { Conversation, Message } from '../core/types';
import {
  activityBatches,
  activityExplanation,
  activityTitle,
  isInternalActivity,
  technicalDetails,
  type Activity,
} from './activity-data';
import { icon } from './icons';
import { taskLabel } from './task-labels';

const signatures = new WeakMap<HTMLElement, string>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function summary(label: string, status: string, count?: number) {
  const node = element('summary', 'activity-summary');
  const mark = element('span', 'activity-mark');
  mark.innerHTML = icon(status === 'completed' ? 'check' : status === 'running' ? 'clock' : 'info');
  node.append(mark, element('span', 'activity-label', label));
  if (count && count > 1) {
    const badge = element('span', 'activity-count', String(count));
    badge.setAttribute('aria-label', `${count} action groups`);
    node.append(badge);
  }
  const arrow = element('span', 'activity-chevron');
  arrow.innerHTML = icon('chevron');
  node.append(arrow);
  return node;
}
function receipt(item: Activity) {
  const { message, outcome, recovered } = item;
  const row = element('details', 'tool-details');
  row.dataset.activityKey = message.id;
  row.dataset.outcome = recovered ? 'recovered' : outcome;
  const suffix = recovered
    ? ' · Retried'
    : outcome === 'failed'
      ? ' · Failed'
      : outcome === 'unknown'
        ? ' · Needs review'
        : '';
  row.append(summary(activityTitle(item) + suffix, recovered ? 'completed' : outcome));
  const body = element('div', 'activity-body');
  body.append(element('p', 'activity-explanation', activityExplanation(item)));
  const technical = element('details', 'activity-technical');
  technical.dataset.activityKey = message.id + ':technical';
  technical.append(element('summary', '', 'Technical details'));
  // Format large output only if the user asks to inspect it.
  technical.addEventListener('toggle', () => {
    if (technical.open && !technical.querySelector('pre'))
      technical.append(element('pre', '', technicalDetails(message)));
  });
  body.append(technical);
  row.append(body);
  return row;
}

/** Keep narration and widgets in place; only receipts belong inside activity cards. */
export function renderToolActivity(timeline: HTMLElement, conversation?: Conversation) {
  if (!conversation) return;
  let turn = 'start';
  const groups = new Map<string, { messages: Message[]; before: Element | null }>();
  const articles = new Map(
    [...timeline.querySelectorAll<HTMLElement>('[data-message-id]')].map((node) => [
      node.dataset.messageId,
      node,
    ]),
  );
  for (const message of conversation.messages) {
    if (isInternalActivity(message)) continue;
    if (message.role === 'user' || message.role === 'assistant') turn = message.id;
    if (message.role !== 'tool') continue;
    const article = articles.get(message.id);
    if (!article) continue;
    const group = groups.get(turn) ?? { messages: [], before: article };
    group.messages.push(message);
    groups.set(turn, group);
    article.hidden = !message.app && !message.file;
  }
  const call = conversation.call;
  const active =
    conversation.turn !== 'background' &&
    call &&
    call.name !== 'background' &&
    (call.state === 'unknown' ||
      (call.state === 'pending' && ['running', 'waiting'].includes(conversation.status)));
  if (active) {
    const group = groups.get(turn) ?? {
      messages: [],
      before: timeline.querySelector('[data-draft]'),
    };
    group.messages.push({
      id: call.id,
      role: 'tool',
      text: call.result ?? '',
      createdAt: conversation.updatedAt,
      tool: `${call.name} · ${call.provider}`,
      activity: { input: call.input, outcome: call.state === 'unknown' ? 'unknown' : 'running' },
    });
    groups.set(turn, group);
  }
  const existing = new Map(
    [...timeline.querySelectorAll<HTMLDetailsElement>('.tool-group')].map((node) => [
      node.dataset.turn,
      node,
    ]),
  );
  for (const [id, data] of groups) {
    let card = existing.get(id);
    if (!card) {
      card = element('details', 'tool-group');
      card.dataset.turn = id;
      timeline.insertBefore(card, data.before);
    }
    // Preserve both disclosure and focus while streamed text updates elsewhere in the chat.
    const signature = JSON.stringify(data.messages);
    if (signatures.get(card) === signature) continue;
    signatures.set(card, signature);
    const opened = new Set(
      [...card.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
        (node) => node.dataset.activityKey,
      ),
    );
    const headingFocused = document.activeElement === card.firstElementChild;
    const focused = card.contains(document.activeElement)
      ? document.activeElement?.closest<HTMLElement>('[data-activity-key]')?.dataset.activityKey
      : undefined;
    const batches = activityBatches(data.messages);
    const failed = batches.some((batch) => batch.failed);
    const running = batches.some((batch) => batch.running);
    const state = failed ? 'failed' : running ? 'running' : 'completed';
    const label = failed
      ? 'Needs attention'
      : running
        ? taskLabel(
            data.messages.find((message) => message.activity?.outcome === 'running')?.tool ?? '',
          )
        : batches.length === 1
          ? batches[0].label
          : data.messages.some((message) => message.activity?.outcome === 'started')
            ? 'Activity'
            : 'Actions completed';
    card.dataset.outcome = state;
    const heading = summary(label, state, batches.length);
    heading.querySelector('.activity-label')!.classList.add('tool-group-label');
    const body = element('div', 'tool-group-steps');
    for (const batch of batches) {
      if (batch.items.length === 1) body.append(receipt(batch.items[0]));
      else {
        const row = element('details', 'activity-batch');
        row.dataset.activityKey = 'batch:' + batch.key;
        row.dataset.outcome = batch.failed ? 'failed' : batch.running ? 'running' : 'completed';
        row.append(
          summary(batch.label + (batch.failed ? ' · Needs attention' : ''), row.dataset.outcome),
        );
        const calls = element('div', 'activity-calls');
        calls.append(...batch.items.map(receipt));
        row.append(calls);
        body.append(row);
      }
    }
    card.replaceChildren(heading, body);
    if (headingFocused) heading.focus({ preventScroll: true });
    for (const node of card.querySelectorAll<HTMLDetailsElement>('details')) {
      if (opened.has(node.dataset.activityKey)) node.open = true;
      if (focused && node.dataset.activityKey === focused)
        node.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    }
  }
  for (const [id, node] of existing) if (!groups.has(id!)) node.remove();
}
