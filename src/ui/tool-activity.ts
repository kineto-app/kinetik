import { openCall } from '../core/turn';
import type { Conversation, Message } from '../core/types';
/** What a window knows about background work: enough for a live step. */
type Job = { id: string; conversationId: string; tool: string; state: string; startedAt?: number };
import { took } from './time';
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
function summary(
  label: string,
  mark: IconName,
  note?: string,
  time?: { ms?: number; startedAt?: number },
) {
  const node = element('summary', 'activity-summary');
  const glyph = element('span', 'activity-mark');
  glyph.innerHTML = icon(mark);
  node.append(glyph, element('span', 'activity-label', label));
  if (note) node.append(element('span', 'activity-note', note));
  if (time?.startedAt !== undefined) {
    // Counted up every second by the window's clock while the step runs.
    const live = element('span', 'activity-time', took(Date.now() - time.startedAt));
    live.dataset.startedAt = String(time.startedAt);
    node.append(live);
    // No job reports how far along it is, so a running step only shows that it is alive.
    const bar = element('span', 'activity-progress');
    bar.setAttribute('aria-hidden', 'true');
    node.append(bar);
    // An instant step needs no time; "0.0s" would only be noise.
  } else if (time?.ms !== undefined && time.ms >= 100)
    node.append(element('span', 'activity-time', took(time.ms)));
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
          : item.outcome === 'running' && item.message.activity?.startedAt === undefined
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
      {
        ms: message.durationMs,
        startedAt: outcome === 'running' ? message.activity?.startedAt : undefined,
      },
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

/** The notice that brings finished background work back into the chat, shown as its step. */
function finishedJob(message: Message): Message | undefined {
  if (!message.id.startsWith('background-completed:')) return undefined;
  const [, tool = 'background · local', state = 'completed'] =
    message.text.match(/^Background job \S+ \((.+?)\) (\w+)\./) ?? [];
  const job = message.id.slice('background-completed:'.length);
  return {
    ...message,
    role: 'tool',
    tool,
    activity: {
      // Each job is its own action, so one job's success never reads as another's retry.
      input: { job },
      // A stop the user asked for is not a failure.
      outcome: state === 'interrupted' ? 'failed' : 'completed',
      label:
        state === 'completed'
          ? taskLabel(tool, true) + ' in the background'
          : state === 'cancelled'
            ? 'Stopped background work'
            : 'Background work was interrupted',
    },
  };
}
const steps = (messages: Message[]) =>
  messages
    .map((message) => finishedJob(message) ?? message)
    .filter((message) => message.role === 'tool' && !isInternalActivity(message));

/** Keep narration and widgets in place; only receipts belong inside activity cards. */
export function renderToolActivity(
  timeline: HTMLElement,
  conversation?: Conversation,
  jobs: Job[] = [],
) {
  if (!conversation) return;
  let turn = 'start';
  const groups = new Map<string, { messages: Message[]; before: Element | null }>();
  const articles = new Map(
    [...timeline.querySelectorAll<HTMLElement>('[data-message-id]')].map((node) => [
      node.dataset.messageId,
      node,
    ]),
  );
  const started = new Map<string, string>();
  for (const original of conversation.messages) {
    const message = finishedJob(original) ?? original;
    if (isInternalActivity(message)) continue;
    if (message.role === 'user' || message.role === 'assistant') turn = message.id;
    const job = jobOf(message);
    if (job) started.set(job, turn);
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
      activity: {
        input: call.input,
        outcome: call.state === 'unknown' ? 'unknown' : 'running',
        startedAt: call.state === 'unknown' ? undefined : call.startedAt,
      },
    });
    groups.set(turn, group);
  }
  // Work still running in the background is a live step of the run that started it.
  for (const job of jobs) {
    if (job.conversationId !== conversation.id || !['running', 'waiting'].includes(job.state))
      continue;
    const key = started.get(job.id) ?? turn;
    const group = groups.get(key) ?? {
      messages: [],
      before: timeline.querySelector('[data-draft]'),
    };
    group.messages.push({
      id: 'job:' + job.id,
      role: 'tool',
      text: '',
      createdAt: job.startedAt ?? conversation.updatedAt,
      tool: job.tool,
      activity: {
        input: {},
        outcome: 'running',
        startedAt: job.startedAt,
        label: taskLabel(job.tool) + ' in the background',
      },
    });
    groups.set(key, group);
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
    const items = batches
      .flatMap((batch) => batch.items)
      .sort((a, b) => data.messages.indexOf(a.message) - data.messages.indexOf(b.message));
    const failed = items.filter(
      (item) => !item.recovered && !handled(item) && ['failed', 'unknown'].includes(item.outcome),
    ).length;
    const fixed = items.filter((item) => item.recovered).length;
    const corrected = items.filter(handled).length;
    const running = items.find((item) => item.outcome === 'running');
    const state = failed ? 'failed' : running ? 'running' : 'completed';
    card.dataset.outcome = state;
    const total = items.reduce((sum, item) => sum + (item.message.durationMs ?? 0), 0);
    const heading = summary(
      running
        ? (running.message.activity?.label ?? taskLabel(running.message.tool ?? '')) + '…'
        : sentence(batches.map((batch) => batch.label)),
      failed ? 'info' : running ? 'clock' : 'check',
      [failed && `${failed} failed`, fixed && `${fixed} fixed`, corrected && `${corrected} handled`]
        .filter(Boolean)
        .join(' · ') || undefined,
      running?.message.activity?.startedAt !== undefined
        ? { startedAt: running.message.activity.startedAt }
        : total
          ? { ms: total }
          : undefined,
    );
    heading.querySelector('.activity-label')!.classList.add('tool-group-label');
    const body = element('div', 'tool-group-steps');
    // A single step would repeat the line's own words; its details open directly instead.
    if (items.length === 1) body.append(stepBody(items[0]));
    else body.append(...items.map(receipt));
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

/** The background job a start step launched, from its `{ id, state }` result. */
function jobOf(message: Message) {
  if (message.role !== 'tool' || !message.tool?.startsWith('background ·')) return undefined;
  try {
    const id = (JSON.parse(message.text) as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}
interface Run {
  user: Message;
  final?: Message;
  messages: Message[];
  jobs: Set<string>;
}
/**
 * A run is a request and everything until its final reply (the one that records how long the turn
 * took): narration, messages sent meanwhile, and background work it started, even when that work
 * finishes after a later request.
 */
export function collectRuns(messages: Message[]) {
  const runs: Run[] = [];
  const owners = new Map<string, Run>();
  let current: Run | undefined;
  for (const message of messages) {
    if (message.id.startsWith('background-completed:')) {
      const owner = owners.get(message.id.slice('background-completed:'.length)) ?? current;
      owner?.messages.push(message);
      current = owner;
      continue;
    }
    if (message.role === 'user' && !isInternalActivity(message)) {
      const last = runs.at(-1);
      if (last && !last.final) {
        last.messages.push(message);
        current = last;
        continue;
      }
      current = { user: message, messages: [], jobs: new Set() };
      runs.push(current);
      continue;
    }
    if (!current) continue;
    current.messages.push(message);
    const job = jobOf(message);
    if (job) {
      current.jobs.add(job);
      owners.set(job, current);
    }
    if (
      message.role === 'assistant' &&
      !isInternalActivity(message) &&
      message.durationMs !== undefined
    ) {
      current.final = message;
      // Background work that woke an earlier run hands the chat back to the latest one.
      current = runs.at(-1);
    }
  }
  return runs;
}
const clock = (time: number) =>
  new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** After each finished run's final reply: how long it took from the request, and every step in it. */
export function renderRuns(
  timeline: HTMLElement,
  conversation: Conversation | undefined,
  busy: boolean,
  jobs: Job[] = [],
) {
  const running = new Set(jobs.map((job) => job.id));
  const runs = conversation ? collectRuns(conversation.messages) : [];
  const kept = new Set<string>();
  runs.forEach((run, index) => {
    const after =
      run.final && timeline.querySelector(`[data-message-id="${CSS.escape(run.final.id)}"]`);
    // A run is not over while its own background work runs, or while the latest one still works.
    if (
      !run.final ||
      !after ||
      [...run.jobs].some((id) => running.has(id)) ||
      (busy && index === runs.length - 1)
    )
      return;
    kept.add(run.user.id);
    const done = steps(run.messages);
    let card = timeline.querySelector<HTMLDetailsElement>(
      `.run-summary[data-run="${CSS.escape(run.user.id)}"]`,
    );
    const signature = JSON.stringify([
      run.final.id,
      done.map((m) => [m.id, m.durationMs, m.activity?.outcome]),
    ]);
    if (!card || signatures.get(card) !== signature) {
      card ??= element('details', 'run-summary');
      card.dataset.run = run.user.id;
      card.dataset.outcome = 'completed';
      signatures.set(card, signature);
      const ms = Math.max(0, run.final.createdAt - run.user.createdAt);
      const [from, to] = [clock(run.user.createdAt), clock(run.final.createdAt)];
      const label = [
        'Worked ' + (ms < 1000 ? '<1s' : took(ms)),
        done.length && `${done.length} ${done.length === 1 ? 'step' : 'steps'}`,
        from === to ? from : `${from} → ${to}`,
      ]
        .filter(Boolean)
        .join(' · ');
      const heading = summary(label, 'check');
      const tokens = run.messages.reduce(
        (sum, m) => sum + (m.usage ? m.usage.input + m.usage.output : 0),
        0,
      );
      heading.title = 'From the request to the final reply' + (tokens ? `. Tokens: ${tokens}` : '');
      const order = new Map(done.map((m, i) => [m.id, i]));
      const body = element('div', 'tool-group-steps');
      body.append(
        ...activityBatches(done)
          .flatMap((batch) => batch.items)
          .sort((a, b) => order.get(a.message.id)! - order.get(b.message.id)!)
          .map(receipt),
      );
      card.replaceChildren(heading, ...(done.length ? [body] : []));
    }
    if (after.nextElementSibling !== card) after.after(card);
  });
  for (const card of timeline.querySelectorAll<HTMLElement>('.run-summary'))
    if (!kept.has(card.dataset.run!)) card.remove();
}
