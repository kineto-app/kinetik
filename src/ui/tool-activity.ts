import { openCall } from '../core/turn';
import type { Conversation, Message } from '../core/types';
import {
  activityBatches,
  activityExplanation,
  activityTitle,
  isInternalActivity,
  technicalParts,
  type Activity,
} from './activity-data';
import { icon, type IconName } from './icons';
import { jsonText, jsonView } from './json-view';
import { copyButton } from './message-content';
import { taskKind, taskLabel } from './task-labels';

const signatures = new WeakMap<HTMLElement, string>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const kindIcons: Record<string, IconName> = {
  read: 'file',
  write: 'file',
  edit: 'file',
  show_file: 'file',
  list: 'folder',
  exec: 'terminal',
  read_skill: 'book',
  find_skill: 'book',
  render: 'monitor',
  job: 'clock',
  job_cancel: 'clock',
  background: 'clock',
  automation: 'clock',
};
function summary(label: string, mark: IconName, note?: string) {
  const node = element('summary', 'activity-summary');
  const glyph = element('span', 'activity-mark');
  glyph.innerHTML = icon(mark);
  node.append(glyph, element('span', 'activity-label', label));
  if (note) node.append(element('span', 'activity-note', note));
  const arrow = element('span', 'activity-chevron');
  arrow.innerHTML = icon('chevron');
  node.append(arrow);
  return node;
}
const handled = (item: Activity) => Boolean(item.message.activity?.returned);
const statusWord = (item: Activity) =>
  item.recovered
    ? 'Fixed'
    : handled(item)
      ? 'Handled'
      : item.outcome === 'failed'
        ? 'Failed'
        : item.outcome === 'unknown'
          ? 'Needs review'
          : item.outcome === 'running'
            ? 'Running'
            : undefined;
/** One step row: what kind of action, a plain title, and a status word only when it matters. */
function receipt(item: Activity) {
  const { message, outcome, recovered } = item;
  const row = element('details', 'tool-details');
  row.dataset.activityKey = message.id;
  row.dataset.outcome = recovered ? 'recovered' : handled(item) ? 'handled' : outcome;
  row.append(
    summary(
      activityTitle(item),
      kindIcons[taskKind(message.tool ?? '')] ?? 'plug',
      statusWord(item),
    ),
    stepBody(item),
  );
  return row;
}
const placeNames: Record<string, string> = { local: 'This device' };
/** A step opens as an inset submenu: what happened, where, and its input and result. */
function stepBody(item: Activity) {
  const { message } = item;
  const body = element('div', 'activity-body');
  body.append(element('p', 'activity-explanation', activityExplanation(item)));
  const parts = technicalParts(message);
  const place =
    parts.provider &&
    (placeNames[parts.provider] ??
      parts.provider.charAt(0).toUpperCase() + parts.provider.slice(1));
  const facts = element('dl', 'activity-facts');
  facts.append(
    element('dt', '', 'Tool'),
    element('dd', '', [parts.tool, place].filter(Boolean).join(' · ')),
  );
  body.append(facts);
  for (const [label, value] of [
    ['Input', parts.input],
    ['Result', parts.result],
  ] as const) {
    if (value === undefined || value === '') continue;
    const block = element('details', 'activity-json');
    block.dataset.activityKey = message.id + ':' + label.toLowerCase();
    const head = element('summary', '');
    const arrow = element('span', 'activity-chevron');
    arrow.innerHTML = icon('chevron');
    head.append(element('span', 'activity-label', label), arrow);
    block.append(head);
    // Format large output only if the user asks to inspect it.
    block.addEventListener('toggle', () => {
      if (!block.open || block.querySelector('pre')) return;
      const view = element('div', 'activity-json-view');
      view.append(
        jsonView(value),
        copyButton(jsonText(value), 'Copy ' + label.toLowerCase(), true),
      );
      block.append(view);
    });
    body.append(block);
  }
  return body;
}

/** "Read 2 files, ran a command and 1 more" — plain words for the collapsed line. */
function sentence(labels: string[]) {
  const shown = labels
    .slice(0, 2)
    .map((label, index) => (index ? label.charAt(0).toLowerCase() + label.slice(1) : label));
  return shown.join(', ') + (labels.length > 2 ? ` and ${labels.length - 2} more` : '');
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
  const call = conversation.turn?.call;
  const active =
    conversation.turn?.kind !== 'background' &&
    call &&
    call.name !== 'background' &&
    (call.state === 'unknown' ||
      (openCall(call) && ['running', 'waiting'].includes(conversation.status)));
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
    const steps = batches
      .flatMap((batch) => batch.items)
      .sort((a, b) => data.messages.indexOf(a.message) - data.messages.indexOf(b.message));
    const failed = steps.filter(
      (item) => !item.recovered && !handled(item) && ['failed', 'unknown'].includes(item.outcome),
    ).length;
    const fixed = steps.filter((item) => item.recovered).length;
    const corrected = steps.filter(handled).length;
    const running = steps.some((item) => item.outcome === 'running');
    const state = failed ? 'failed' : running ? 'running' : 'completed';
    card.dataset.outcome = state;
    const heading = summary(
      running
        ? taskLabel(steps.find((item) => item.outcome === 'running')!.message.tool ?? '') + '…'
        : sentence(batches.map((batch) => batch.label)),
      failed ? 'info' : running ? 'clock' : 'check',
      [failed && `${failed} failed`, fixed && `${fixed} fixed`, corrected && `${corrected} handled`]
        .filter(Boolean)
        .join(' · ') || undefined,
    );
    heading.querySelector('.activity-label')!.classList.add('tool-group-label');
    const body = element('div', 'tool-group-steps');
    // A single step would repeat the line's own words; its details open directly instead.
    if (steps.length === 1) body.append(stepBody(steps[0]));
    else body.append(...steps.map(receipt));
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
