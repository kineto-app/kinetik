import { MessageBubble } from './ui/message';
import { makePreview, trayItem } from './ui/attachments';
import { ModelPicker } from './ui/model-picker';
import { setupDataTransfer } from './ui/data-transfer';
import { createSignal } from 'solid-js';
import { ConversationList } from './ui/lists';
import { isNative } from './platform/environment';
import { setupViewport } from './browser/viewport';
import { renderToolActivity } from './ui/tool-activity';
import { isInternalActivity } from './ui/activity-data';
import { elapsed } from './ui/time';
import { renderMessageContent } from './ui/message-content';
import './ui/styles.css';
import './ui/chat.css';
import './ui/islands.css';
import { setupAutomations, renderAutomations } from './ui/automations';
import type { Automation } from './core/automation';
import { Shell } from './ui/shell';
import { render as renderSolid } from 'solid-js/web';
import { icon, type IconName } from './ui/icons';
import { demoTasks } from './core/demo-tasks';
import { openCall } from './core/turn';
import { taskLabel } from './ui/task-labels';
import { setupFiles } from './ui/files';
import { setupUpdates } from './browser/updates';
import { connect, rpc } from './browser/client';
import type { Conversation, InstalledPlugin, RuntimeEvent } from './core/types';
import type { CustomModelState } from './connections/custom-model';
import { setupConnections } from './ui/onboarding';
import {
  setSettingsActions,
  setSettingsPlugins,
  setSettingsSetup,
  showAddedPlugin,
  showSettings,
  refreshSettingsData,
} from './ui/settings';
import type { SetupState } from './connections/manager';
import { byId } from './ui/dom';
import { renderAsk } from './ui/ask-panel';
import { latestThought, renderThought } from './ui/thought';
import { closeDrawer, setupDrawer } from './ui/drawer';

type State = {
  background: {
    id: string;
    conversationId: string;
    tool: string;
    state: string;
    startedAt?: number;
  }[];
  automations: Automation[];
  conversations: Conversation[];
  plugins: Pick<InstalledPlugin, 'manifest' | 'source' | 'enabledAt' | 'digest'>[];
};
const root = document.querySelector<HTMLDivElement>('#app')!;
renderSolid(Shell, root);
setupViewport();
let state: State = { conversations: [], plugins: [], automations: [], background: [] };
let connectionState: SetupState | undefined;
const [modelState, setModelState] = createSignal({ chatgpt: false, hostChatgpt: false, model: '' });
/** The hidden OpenAI-compatible model from Settings → ChatGPT → Advanced. */
const [customModel, setCustomModel] = createSignal<{ configured: boolean; chosen: boolean }>({
  configured: false,
  chosen: false,
});
async function refreshCustomModel() {
  const result = await rpc<CustomModelState>('customModel', { action: 'state' });
  setCustomModel({ configured: result.configured, chosen: result.chosen });
  // The empty chat's ChatGPT hint depends on the choice.
  if (!current()?.messages.length) lastMessages = '';
  render();
}
window.addEventListener('kinetik-compose', (event) => {
  const { conversationId, text } = (event as CustomEvent<{ conversationId: string; text: string }>)
    .detail;
  if (conversationId !== selected) return;
  const prompt = byId<HTMLTextAreaElement>('prompt');
  const draft = prompt.value.trim() ? prompt.value + '\n' + text : text;
  prompt.value = draft.slice(0, 4000);
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  prompt.focus();
});
window.addEventListener('kinetik-custom-model', () => {
  void refreshCustomModel().catch(showError);
  // A turn waiting for a key continues once one is saved.
  void resumeWork();
});
/** The turn runs on the custom model, which uses an API key instead of a sign-in. */
function apiKeyTurn(c: Conversation) {
  return c.turn?.model?.provider === 'custom';
}
renderSolid(
  () =>
    ModelPicker({
      get enabled() {
        return modelState().chatgpt || customModel().configured;
      },
      get chatgpt() {
        return modelState().chatgpt;
      },
      get hostChatgpt() {
        return modelState().hostChatgpt;
      },
      get model() {
        return modelState().model;
      },
      onSelected: async () => {
        await refreshCustomModel();
        await connectionSetup.refresh();
      },
    }),
  byId('model-picker'),
);
const uiStorage = isNative ? localStorage : sessionStorage;
let selected = uiStorage.getItem('kinetik-conversation') ?? '';
let refreshGeneration = 0;
let lastMessages = '';
let followNextMessage = false;
let disposeContent: (() => void)[] = [];
let timelineConversation = '';
let draftText = '';
let draftFrame = 0;
const shownDrafts = new WeakMap<Element, string>();
function renderDraft() {
  draftFrame = 0;
  const timeline = byId('timeline');
  const draft = timeline.querySelector('[data-draft]');
  if (!draft || shownDrafts.get(draft) === draftText) return;
  shownDrafts.set(draft, draftText);
  const follow = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
  const content = renderMessageContent(draftText);
  content.classList.add('streaming-content');
  draft.querySelector('.message-content')!.replaceWith(content);
  if (follow) timeline.scrollTop = timeline.scrollHeight;
  updateJumpButton();
}
const renderedMessages = new Set<string>();
const draftKey = 'kinetik-composer';
byId<HTMLTextAreaElement>('prompt').value = uiStorage.getItem(draftKey) ?? '';
const isBackgroundTurn = (c: Conversation) => {
  if (c.turn?.kind) return c.turn.kind === 'background';
  const active = c.messages.find((m) => m.id === (c.turn?.message ?? c.pending[0]));
  return active?.source === 'background' || Boolean(active?.id.startsWith('background-completed:'));
};
const current = () => state.conversations.find((c) => c.id === selected);
function showError(error: unknown, target = 'error') {
  byId(target).textContent = error instanceof Error ? error.message : String(error);
  byId(target).dataset.kind = 'error';
}
function button(
  text: string,
  action: () => void | Promise<void>,
  className = '',
): HTMLButtonElement {
  const result = document.createElement('button');
  result.textContent = text;
  result.className = className;
  result.addEventListener('click', () => {
    void Promise.resolve(action()).catch((error) => showError(error));
  });
  return result;
}
function choose(id: string) {
  selected = id;
  uiStorage.setItem('kinetik-conversation', id);
  lastMessages = '';
  // Only the open chat carries its messages, so a newly opened one is fetched before it shows.
  void refresh().catch(showError);
  closeDrawer(false);
  byId('prompt').focus();
}
const [view, setView] = createSignal({ state, selected });
renderSolid(
  () =>
    ConversationList({
      get conversations() {
        return view().state.conversations;
      },
      get selected() {
        return view().selected;
      },
      background: isBackgroundTurn,
      choose,
    }),
  byId('conversations'),
);
function render() {
  setView({ state, selected });
  const c = current();
  renderAttachments();
  const foreground = c?.status === 'running' && !isBackgroundTurn(c);
  const jobs = state.background ?? [];
  const processing = state.conversations.some(
    (item) => item.status === 'running' && isBackgroundTurn(item),
  );
  byId('background-activity').hidden = !jobs.length && !processing;
  byId('background-label').textContent = jobs.length
    ? `${jobs.length} background ${jobs.length === 1 ? 'task' : 'tasks'} running`
    : 'Processing background result';
  byId('title').textContent = c?.title ?? 'New chat';
  byId('delete-chat').hidden = !c?.messages.length || foreground;
  byId('status').textContent = foreground
    ? 'Working…'
    : c?.status === 'needs_review'
      ? 'Needs review'
      : c?.status === 'asking'
        ? 'Waiting for your answer'
        : 'Ready';
  byId('composer-hint').textContent = foreground
    ? 'Send another message to guide Kinetik as it works.'
    : 'Enter for a new line. Use Send to send your message.';
  byId('connection-wait').hidden = c?.status !== 'waiting';
  byId('connection-wait-label').textContent =
    c?.waitingFor === 'signin'
      ? apiKeyTurn(c)
        ? 'Check your API key to continue'
        : 'Sign in to continue'
      : navigator.onLine
        ? 'Reconnecting…'
        : 'Waiting for connection…';
  scheduleReconnect();
  byId('resume-work').textContent =
    c?.waitingFor === 'signin' ? (apiKeyTurn(c) ? 'Check API key' : 'Sign in') : 'Retry now';
  updateComposer();
  byId('status').dataset.state = c?.status ?? 'idle';
  byId('activity').hidden = !foreground;
  const thought =
    foreground && c?.live?.reasoning && !c.draft && !openCall(c.turn?.call)
      ? latestThought(c.live.reasoning)
      : undefined;
  byId('activity-label').textContent =
    (openCall(c?.turn?.call)
      ? taskLabel(c!.turn!.call!.name)
      : c?.live?.activity === 'summarising'
        ? 'Summarising earlier messages…'
        : (thought?.heading ?? 'Working')) +
    (c?.live && c.live.step > 1 ? ` · step ${c.live.step}` : '') +
    (c?.live?.helperStep ? ` · helper step ${c.live.helperStep}` : '');
  renderThought(thought);
  updateElapsed();
  byId('recovery').hidden = c?.status !== 'needs_review';
  renderAsk(c, (id, value) => rpc('answer', { id, value }).then(refresh).catch(showError));
  const serialized = JSON.stringify([selected, c?.messages, c?.draft, c?.turn?.call, c?.status]);
  if (serialized !== lastMessages) {
    const forceScroll = !lastMessages || followNextMessage;
    followNextMessage = false;
    lastMessages = serialized;
    const timeline = byId('timeline');
    const oldScroll = timeline.scrollTop;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    if (timelineConversation !== selected || !c?.messages.length) {
      disposeContent.forEach((dispose) => dispose());
      disposeContent = [];
      renderedMessages.clear();
      timeline.replaceChildren();
      timelineConversation = selected;
    }
    if (c?.messages.length) timeline.querySelector('.empty')?.remove();
    let replacesDraft = false;
    if (!c?.draft || isBackgroundTurn(c)) {
      const draft = timeline.querySelector('[data-draft]');
      replacesDraft = Boolean(draft);
      draft?.remove();
    }
    if (!c?.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `<div class="welcome-mark" aria-hidden="true">${icon('spark')}</div><h2>What can we get done today?</h2><div class="starter"><div class="suggestions"></div></div><p class="preview-note">Preview uses sample replies. ChatGPT is not connected.</p>`;
      if (connectionState?.chatgpt.available) {
        empty.querySelector('.preview-note')!.textContent =
          connectionState.chatgpt.connected || customModel().chosen
            ? ''
            : 'Connect ChatGPT to start a conversation.';
      }
      const examples: [string, IconName, string][] = [
        ...demoTasks.map((task): [string, IconName, string] => [task.title, 'file', task.prompt]),
        ['Find my files', 'folder', 'Show my saved files.'],
      ];
      for (const [label, glyph, text] of examples) {
        const action = button(
          '',
          () => {
            byId<HTMLTextAreaElement>('prompt').value = text;
            updateComposer();
            byId('prompt').focus();
          },
          'action-row starter-card',
        );
        action.innerHTML = `<span class="glyph">${icon(glyph)}</span><span class="action-main"><span class="action-title">${label}</span></span>${icon('chevron')}`;
        empty.querySelector('.suggestions')!.append(action);
      }
      timeline.append(empty);
    }
    for (const item of c?.messages ?? []) {
      timeline
        .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)
        ?.toggleAttribute('data-queued', Boolean(item.queue));
      timeline
        .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)
        ?.toggleAttribute('data-unsent', Boolean(item.unsent));
      const hiddenActivity = isInternalActivity(item);
      if ((hiddenActivity && !item.app && !item.file) || renderedMessages.has(item.id)) continue;
      renderedMessages.add(item.id);
      const article = document.createElement('article');
      // The reply that replaces a streamed draft must not slide in.
      article.className =
        replacesDraft && item.role === 'assistant' ? 'message' : 'message message-enter';
      if (item.role === 'assistant') replacesDraft = false;
      article.dataset.role = item.role;
      article.dataset.messageId = item.id;
      article.toggleAttribute('data-queued', Boolean(item.queue));
      article.toggleAttribute('data-unsent', Boolean(item.unsent));
      article.toggleAttribute('data-aborted', Boolean(item.aborted));
      timeline.insertBefore(article, timeline.querySelector('[data-draft]'));
      disposeContent.push(
        renderSolid(
          () => MessageBubble({ item, article, conversationId: c!.id, resized: updateJumpButton }),
          article,
        ),
      );
    }
    if (c?.draft && !isBackgroundTurn(c)) {
      let draft = timeline.querySelector<HTMLElement>('[data-draft]');
      if (!draft) {
        draft = document.createElement('article');
        draft.className = 'message streaming-message';
        draft.dataset.draft = 'true';
        // Re-rendered content would otherwise be re-announced in full on every frame.
        draft.setAttribute('aria-busy', 'true');
        // Holds the line the final reply's "Worked for" takes, so the swap does not shift text.
        draft.innerHTML = `<div class="work-duration">${icon('clock')}Working…</div><div class="message-label"><img src="./icon.svg" width="24" height="24" alt="" />Kinetik<span class="streaming-label">Writing</span></div><div class="message-content streaming-content"></div>`;
        timeline.append(draft);
      }
      draftText = c.draft;
      draftFrame ||= requestAnimationFrame(renderDraft);
    }
    renderToolActivity(timeline, c);
    timeline.scrollTop = !c?.messages.length
      ? 0
      : forceScroll || nearBottom
        ? timeline.scrollHeight
        : oldScroll;
  }
  updateJumpButton();
  renderAutomations(state.automations, refresh, choose);
  setSettingsPlugins(state.plugins);
}
async function refresh() {
  const generation = ++refreshGeneration;
  let next = await rpc<State>('state', { conversation: selected });
  if (generation !== refreshGeneration) return;
  if (!next.conversations.some((c) => c.id === selected) && next.conversations.length) {
    selected = next.conversations[0].id;
    next = await rpc<State>('state', { conversation: selected });
    if (generation !== refreshGeneration) return;
  }
  state = next;
  uiStorage.setItem('kinetik-conversation', selected);
  render();
}
let submitting = false;
let pickingFile = false;
function renderAttachments() {
  const container = byId('attachments');
  const files = current()?.attachments ?? [];
  container.hidden = !files.length;
  container.setAttribute('aria-busy', String(submitting));
  const conversationId = selected;
  container.replaceChildren(
    ...files.map((file) =>
      trayItem(
        file,
        () => {
          void rpc('attachmentRemove', { id: conversationId, attachmentId: file.id })
            .then(refresh)
            .catch(showError);
        },
        submitting,
      ),
    ),
  );
}
async function stageFile(file: { name: string; bytes: Uint8Array }) {
  if (!current()) selected = (await rpc<Conversation>('create')).id;
  const preview = await makePreview(file.name, file.bytes);
  await rpc('attachmentStage', { id: selected, ...file, ...(preview ? { preview } : {}) });
  byId('error').textContent = '';
  await refresh();
}
function updateComposer() {
  const input = byId<HTMLTextAreaElement>('prompt');
  input.readOnly = submitting;
  const busy =
    ['running', 'queued', 'waiting'].includes(current()?.status ?? '') ||
    state.background.some((job) => job.conversationId === selected);
  const hasAttachments = Boolean(current()?.attachments?.length);
  const stopping = busy && !input.value.trim() && !hasAttachments;
  byId('stop').hidden = !stopping;
  byId('send').hidden = stopping;
  // While work runs, Send steers it now; the clock queues the message for afterwards.
  byId('queue').hidden = !busy || stopping;
  byId<HTMLButtonElement>('queue').disabled = submitting || pickingFile;
  byId('work-options').hidden = !busy;
  if (!busy) byId<HTMLDetailsElement>('work-options').open = false;
  byId<HTMLButtonElement>('send').disabled =
    submitting || pickingFile || (!input.value.trim() && !hasAttachments);
  byId<HTMLButtonElement>('attach').disabled = submitting || pickingFile;
  byId('attachment-status').textContent = pickingFile
    ? 'Adding file…'
    : submitting && hasAttachments
      ? 'Sending files…'
      : '';
  uiStorage.setItem(draftKey, input.value);
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 144) + 'px';
  // A single row is a pill; extra lines or the tray need straight sides.
  byId('composer').classList.toggle('expanded', hasAttachments || input.scrollHeight > 48);
}
byId('prompt').addEventListener('input', updateComposer);
setupDrawer();
byId('new-chat').onclick = () => {
  void (async () => {
    const c = await rpc<Conversation>('create');
    choose(c.id);
  })().catch(showError);
};
byId('top-new-chat').onclick = () => byId('new-chat').click();
let queueNext = false;
let unsent: { draft: string; id: string } | undefined;
byId('queue').onclick = () => {
  queueNext = true;
  byId<HTMLFormElement>('composer').requestSubmit();
};
byId('composer').onsubmit = (event) => {
  event.preventDefault();
  const queue = queueNext ? 'after' : undefined;
  queueNext = false;
  void (async () => {
    const input = byId<HTMLTextAreaElement>('prompt');
    const text = input.value;
    const attachments = current()?.attachments?.map((file) => file.id) ?? [];
    if ((!text.trim() && !attachments.length) || submitting || pickingFile) return;
    submitting = true;
    renderAttachments();
    updateComposer();
    try {
      // A chosen custom model needs no ChatGPT sign-in.
      if (connectionState?.chatgpt.available && !customModel().chosen) {
        await connectionSetup.refresh();
        if (!connectionState.chatgpt.connected) {
          connectionSetup.open();
          return;
        }
      }
      if (!current()) selected = (await rpc<Conversation>('create')).id;
      followNextMessage = true;
      // Sending the same draft again after a failure reuses its id, so it is never posted twice.
      const sending = JSON.stringify([selected, text, attachments]);
      if (unsent?.draft !== sending) unsent = { draft: sending, id: crypto.randomUUID() };
      await rpc('submit', { id: selected, text, attachments, queue, messageId: unsent.id });
      unsent = undefined;
      input.value = '';
      updateComposer();
      byId('error').textContent = '';
      await refresh();
      input.focus();
    } finally {
      submitting = false;
      renderAttachments();
      updateComposer();
    }
  })().catch(showError);
};
byId('stop').onclick = byId('cancel-work').onclick = () => {
  byId<HTMLDetailsElement>('work-options').open = false;
  void rpc('stop', { id: selected }).then(refresh).catch(showError);
};
for (const [id, retry] of [
  ['resolve', false],
  ['retry', true],
] as const)
  byId(id).onclick = () => {
    void rpc('resolve', { id: selected, retry }).then(refresh).catch(showError);
  };
byId('delete-chat').onclick = () => openDialog('delete');
byId('delete-confirm').onclick = () => {
  const id = selected;
  byId<HTMLDialogElement>('delete-dialog').close();
  void rpc('delete', { id })
    .then(() => {
      selected = state.conversations.find((c) => c.id !== id)?.id ?? '';
      return refresh();
    })
    .catch(showError);
};
function openDialog(name: string) {
  closeDrawer();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog:modal')) dialog.close();
  byId<HTMLDialogElement>(name + '-dialog').showModal();
}
byId('automations-open').onclick = () => openDialog('automations');
byId('settings-open').onclick = () => {
  showSettings();
  void refreshSettingsData().catch(showError);
  openDialog('settings');
};
byId('attach').onclick = () => {
  if (!isNative) {
    byId<HTMLInputElement>('upload').click();
    return;
  }
  pickingFile = true;
  updateComposer();
  void import('./platform/files')
    .then(async ({ pickNativeFiles, readNativeFile }) => {
      for (const path of await pickNativeFiles()) await stageFile(await readNativeFile(path));
    })
    .catch(showError)
    .finally(() => {
      pickingFile = false;
      updateComposer();
    });
};
for (const close of document.querySelectorAll<HTMLButtonElement>('[data-close]'))
  close.onclick = () => byId<HTMLDialogElement>(close.dataset.close!).close();
byId('example').onclick = () => {
  byId<HTMLInputElement>('plugin-source').value = new URL(
    'plugins/example/plugin.json',
    document.baseURI,
  ).href;
};
byId('plugin-form').onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    const install = byId<HTMLButtonElement>('install');
    if (install.disabled) return;
    install.disabled = true;
    install.textContent = 'Adding…';
    byId('plugin-error').textContent = '';
    byId('plugin-error').dataset.kind = '';
    try {
      const source = byId<HTMLInputElement>('plugin-source').value;
      await rpc('install', {
        source,
        settings: byId<HTMLTextAreaElement>('plugin-settings').value,
      });
      await refresh();
      const added = state.plugins.find((p) => p.source === source);
      if (added) showAddedPlugin(added.manifest.id);
      byId('plugin-error').textContent =
        'Added. Choose Turn on to let Kinetik use this connection.';
      byId('plugin-error').dataset.kind = 'success';
    } finally {
      install.disabled = false;
      install.textContent = 'Add connection';
    }
  })().catch((error) => showError(error, 'plugin-error'));
};
function updateJumpButton() {
  const timeline = byId('timeline');
  byId('jump-latest').hidden =
    !timeline.querySelector('.message') ||
    timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
}
byId('timeline').addEventListener('scroll', updateJumpButton, { passive: true });
new ResizeObserver(updateJumpButton).observe(byId('timeline'));
byId('jump-latest').onclick = () => {
  const timeline = byId('timeline');
  timeline.scrollTo({
    top: timeline.scrollHeight,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  });
};
let refreshTimer: ReturnType<typeof setTimeout>;
let sidebarTimer: ReturnType<typeof setTimeout>;
function updateElapsed() {
  const c = current();
  const now = Date.now();
  for (const id of ['activity', 'connection-wait', 'background-activity']) {
    const parent = byId(id);
    let timer = parent.querySelector<HTMLElement>('.elapsed-time');
    const starts =
      id === 'background-activity'
        ? state.background
            .map((job) => job.startedAt)
            .filter((value): value is number => value !== undefined)
        : c?.turn?.startedAt === undefined
          ? []
          : [c.turn.startedAt];
    if (parent.hidden || !starts.length) {
      timer?.remove();
      continue;
    }
    if (!timer) {
      timer = document.createElement('span');
      timer.className = 'elapsed-time';
      timer.setAttribute('aria-live', 'off');
      timer.title = 'Elapsed time, including connection waits';
      const button = parent.querySelector('button');
      if (button) button.before(timer);
      else parent.append(timer);
    }
    timer.textContent = '· ' + elapsed(now - Math.min(...starts));
  }
}
setInterval(() => {
  if (!document.hidden) updateElapsed();
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateElapsed();
});
window.addEventListener('kinetik-changed', (event) =>
  changed((event as CustomEvent<RuntimeEvent | undefined>).detail),
);
window.addEventListener('kinetik-native-error', (event) =>
  showError((event as CustomEvent).detail),
);
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'changed') changed(event.data.event);
});
/** Streamed text and step progress patch the open state; anything else reloads it. */
function changed(event: RuntimeEvent | undefined) {
  const streaming = event && ['text', 'progress', 'reasoning'].includes(event.type);
  let c = streaming
    ? state.conversations.find((item) => item.id === event.conversationId)
    : undefined;
  // A chat held only as a summary shows no stream: the open one is fetched, the rest wait.
  if (c && !c.messages.length && c.id !== selected) return;
  if (c && !c.messages.length) c = undefined;
  if (c && event?.type === 'text' && c.status === 'running') {
    c.draft = event.text;
    render();
    return;
  }
  if (c && event?.type === 'progress' && c.status === 'running') {
    c.live = {
      step: event.step,
      tool: event.tool,
      activity: event.activity,
      helperStep: event.helperStep,
    };
    render();
    return;
  }
  if (c && event?.type === 'reasoning' && c.status === 'running') {
    c.live = { step: c.live?.step ?? 1, reasoning: event.text };
    render();
    return;
  }
  // A change in a chat that is not open only moves the sidebar, so it can wait a little.
  if (event?.type === 'changed' && event.conversationId && event.conversationId !== selected) {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => void refresh().catch(showError), 500);
    return;
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh().catch(showError), 30);
}
async function start() {
  const registration = await connect();
  const updatesReady = registration
    ? setupUpdates(registration)
    : import('./platform/updates').then(({ setupNativeUpdates }) => setupNativeUpdates());
  await refresh();
  await refreshCustomModel().catch(() => {});
  await connectionSetup.initialize();
  await rpc('resume');
  await rpc('tick');
  await updatesReady;
  // The build is complete before the one-shot local launcher is allowed to exit.
  if (!registration) return;
  if (registration.installing)
    await new Promise<void>((resolve) => {
      registration.installing!.addEventListener('statechange', () => {
        if (
          !registration.installing ||
          ['installed', 'activated', 'redundant'].includes(registration.installing.state)
        )
          resolve();
      });
    });
  try {
    const endpoint = new URL('__launcher', document.baseURI);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
    if (response.ok && response.headers.get('Content-Type')?.includes('application/json')) {
      const { nonce } = await response.json();
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'X-Kinetik-Ready': nonce },
        signal: AbortSignal.timeout(2000),
      });
    }
  } catch {
    /* Hosted and offline copies have no launcher. */
  }
}
setupFiles(async (file) => {
  pickingFile = true;
  updateComposer();
  try {
    await stageFile(file);
  } finally {
    pickingFile = false;
    updateComposer();
  }
});
setupDataTransfer();
setupAutomations(refresh);
const connectionSetup = setupConnections((value) => {
  if (JSON.stringify(connectionState) === JSON.stringify(value)) return;
  const becameConnected =
    (value.chatgpt.connected && !connectionState?.chatgpt.connected) ||
    (value.charms.status === 'connected' && connectionState?.charms.status !== 'connected');
  connectionState = value;
  setSettingsSetup(value);
  setModelState({
    chatgpt: Boolean(value.chatgpt.connected && value.chatgpt.browser),
    hostChatgpt: Boolean(value.chatgpt.connected && !value.chatgpt.browser),
    model: value.chatgpt.model ?? '',
  });
  if (becameConnected) void resumeWork();
  const configured = value.charms.available || value.chatgpt.available;
  const attention =
    (value.chatgpt.available && !value.chatgpt.connected) || value.charms.status === 'reconnect';
  byId('connection-status').hidden = !attention;
  byId('connections-dot').dataset.attention = String(attention);
  const connected = [
    value.chatgpt.connected ? 'ChatGPT' : '',
    value.charms.status === 'connected' ? 'Charms' : '',
  ].filter(Boolean);
  byId('connections-dot').hidden = !attention && !connected.length;
  byId('connections-summary').textContent = attention
    ? 'Needs attention'
    : connected.join(' · ') || (configured ? 'Not connected' : 'Manage services');
  byId('connection-status').innerHTML = icon('plug');
  byId('connection-status').classList.add('icon-button');
  byId('connection-status').title =
    value.chatgpt.available && !value.chatgpt.connected ? 'Connect ChatGPT' : 'Reconnect Charms';
  if (value.chatgpt.available) {
    byId('model-label').textContent = 'ChatGPT';
    byId('model-status').textContent = value.chatgpt.connected
      ? 'ChatGPT subscription'
      : 'Connect ChatGPT to chat';
  }
  if (!current()?.messages.length) lastMessages = '';
  render();
});
byId('install-open').onclick = () => {
  closeDrawer(false);
  connectionSetup.install();
};
function openSetup() {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog:modal')) dialog.close();
  connectionSetup.open();
}
byId('connections-open').onclick = () => {
  const value = connectionState;
  // Guided setup only while something is missing; a connection turned off on purpose is not.
  if (
    (value?.chatgpt.available && !value.chatgpt.connected) ||
    (value?.charms.available && ['not-connected', 'reconnect'].includes(value.charms.status))
  ) {
    closeDrawer(false);
    connectionSetup.open();
    return;
  }
  showSettings('connections');
  openDialog('settings');
};
byId('connection-status').onclick = openSetup;
setSettingsActions({
  connect: openSetup,
  async enable(id, enabled) {
    await rpc('enable', { id, enabled });
    await refresh();
    if (id === 'charms') await connectionSetup.refresh();
  },
  async update(id) {
    await rpc('update', { id });
    await refresh();
    if (id === 'charms') await connectionSetup.refresh();
  },
  async disconnect(kind) {
    if (kind === 'charms') {
      await connectionSetup.disconnectCharms();
      await refresh();
    } else await connectionSetup.disconnectChatGPT();
  },
});
window.addEventListener('focus', () => {
  void connectionSetup.refresh().catch(() => {});
});
setInterval(() => {
  void connectionSetup.refresh().catch(() => {});
}, 30000);
updateComposer();
setInterval(() => {
  void rpc('tick')
    .then(refresh)
    .catch(() => {});
}, 15000);
window.addEventListener('online', () => {
  void rpc('tick').then(refresh).catch(showError);
});
void start().catch(showError);

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (document.visibilityState !== 'visible' || !navigator.onLine) return;
  const waiting = state.conversations.filter(
    (c) => c.status === 'waiting' && c.waitingFor === 'connection',
  );
  if (!waiting.length) return;
  const next = Math.min(...waiting.map((c) => c.retryAt ?? Date.now() + 2000));
  reconnectTimer = setTimeout(() => void resumeWork(), Math.max(250, next - Date.now()));
}
window.addEventListener('offline', () => {
  clearTimeout(reconnectTimer);
  render();
});
let resuming: Promise<void> | undefined;
function resumeWork() {
  return (resuming ??= rpc('resume')
    .then(refresh)
    .catch(showError)
    .finally(() => {
      resuming = undefined;
    }));
}
byId('resume-work').onclick = () => {
  const c = current();
  if (c?.waitingFor === 'signin' && apiKeyTurn(c)) {
    // A custom-model turn waits for its API key, not for ChatGPT.
    showSettings('custom');
    void refreshSettingsData().catch(showError);
    openDialog('settings');
  } else if (c?.waitingFor === 'signin') connectionSetup.open();
  else void resumeWork();
};
window.addEventListener('online', () => {
  void resumeWork();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void resumeWork();
  else clearTimeout(reconnectTimer);
});
setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    navigator.onLine &&
    (state.background.length ||
      state.conversations.some((c) => c.status === 'waiting' && c.waitingFor !== 'signin'))
  )
    void resumeWork();
}, 30000);
