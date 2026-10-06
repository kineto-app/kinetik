import { failureKind } from './core/connection-error';
import { MessageBubble } from './ui/message';
import { makePreview, trayItem } from './ui/attachments';
import { ModelPicker } from './ui/model-picker';
import { setupDataTransfer } from './ui/data-transfer';
import { createSignal } from 'solid-js';
import { ConversationList } from './ui/lists';
import { capabilities, isNative } from './platform/environment';
import { setAppDetails } from './ui/app-details';
import { setupViewport } from './browser/viewport';
import { renderRuns, renderToolActivity } from './ui/tool-activity';
import { isInternalActivity } from './ui/activity-data';
import { elapsed, took } from './ui/time';
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
  setSettingsChats,
  toggleNotifications,
  setSettingsSetup,
  showAddedPlugin,
  showSettings,
  refreshSettingsData,
} from './ui/settings';
import type { SetupState } from './connections/manager';
import { byId } from './ui/dom';
import { toast } from './ui/toast';
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
  updateConnectionStatus();
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
let shownGeneration = 0;
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
/** Results already announced by a toast; only those produced after the app opened are. */
const announced = new Set<string>();
const openedAt = Date.now();
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
function reportFirstUse(ok: boolean) {
  if (isNative)
    void import('./platform/updates')
      .then(({ reportUpdateFirstUse }) => reportUpdateFirstUse(ok))
      .catch(() => {});
}
function choose(id: string, focus = true) {
  markRead(id);
  selected = id;
  uiStorage.setItem('kinetik-conversation', id);
  lastMessages = '';
  // Only the open chat carries its messages, so a newly opened one is fetched before it shows.
  void refresh()
    .then(() => reportFirstUse(true))
    .catch((error) => {
      reportFirstUse(false);
      showError(error);
    });
  closeDrawer(false);
  // Opened from a notification, the chat is for reading; the keyboard would hide it.
  if (focus) byId('prompt').focus();
}
const [view, setView] = createSignal({ state, selected });
/** Chats that finished or asked something while another chat was open. */
function storedUnread() {
  try {
    const value = JSON.parse(localStorage.getItem('kinetik-unread') ?? '[]');
    return new Set<string>(
      Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [],
    );
  } catch {
    return new Set<string>();
  }
}
const [unread, setUnread] = createSignal(storedUnread());
function markRead(id: string, read = true) {
  const next = new Set(unread());
  if (read) next.delete(id);
  else next.add(id);
  setUnread(next);
  try {
    localStorage.setItem('kinetik-unread', JSON.stringify([...next]));
  } catch {
    /* Without storage the dots last until the app closes. */
  }
}
const working = ['running', 'queued', 'waiting'];
/** Tells about work that ended in another chat, and offers notifications after a long task here. */
/** When the page first saw each chat at work; the turn record can be gone a moment before. */
const workingSince = new Map<string, number>();
function noticeFinished(before: Conversation[], after: Conversation[]) {
  for (const c of after) {
    const previous = before.find((item) => item.id === c.id);
    if (working.includes(c.status)) {
      if (!workingSince.has(c.id))
        workingSince.set(c.id, Math.min(c.turn?.startedAt ?? Date.now(), Date.now()));
      continue;
    }
    const since = workingSince.get(c.id);
    workingSince.delete(c.id);
    if (!previous || !working.includes(previous.status)) continue;
    const verb =
      c.status === 'asking'
        ? 'has a question'
        : c.status === 'needs_review'
          ? 'needs a look'
          : c.status === 'idle'
            ? 'is ready'
            : undefined;
    if (!verb) continue;
    if (c.id !== selected) {
      markRead(c.id, false);
      toast({
        key: 'chat:' + c.id,
        text: `“${c.title}” ${verb}`,
        ms: 8000,
        action: { label: 'Open', run: () => choose(c.id, false) },
      });
    } else if (c.status === 'idle' && since !== undefined && Date.now() - since > 15000)
      void offerNotifications();
  }
}
async function offerNotifications() {
  try {
    if (
      localStorage.getItem('kinetik-notify-offered') ||
      !(connectionState?.capabilities ?? capabilities('unknown')).notifications ||
      !(isNative || ('Notification' in window && Notification.permission !== 'denied'))
    )
      return;
  } catch {
    return;
  }
  if (await rpc<boolean>('notifications')) return;
  localStorage.setItem('kinetik-notify-offered', '1');
  toast({
    text: 'Want a notification when work is done?',
    ms: 15000,
    action: {
      label: 'Turn on',
      run: () =>
        void toggleNotifications(true)
          .then(() => toast({ text: 'Notifications are on', ms: 3000 }))
          .catch(showError),
    },
  });
}
window.addEventListener('kinetik-open-chat', (event) => {
  const id = (event as CustomEvent<string>).detail;
  // A tap from a cold start arrives before the chats load; refresh falls back if the id is gone.
  if (typeof id !== 'string' || !id) return;
  // The composer may still hold focus from before the app was left; the keyboard would cover the reply.
  (document.activeElement as HTMLElement | null)?.blur();
  choose(id, false);
});
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
      get unread() {
        return unread();
      },
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
  byId('activity-label').textContent = openCall(c?.turn?.call)
    ? taskLabel(c!.turn!.call!.name)
    : c?.live?.activity === 'summarising'
      ? 'Summarising earlier messages…'
      : (thought?.heading ?? 'Working');
  byId('activity-label').title = [
    c?.live && c.live.step > 1 ? `Step ${c.live.step}` : '',
    c?.live?.helperStep ? `helper step ${c.live.helperStep}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  renderThought(thought);
  updateElapsed();
  byId('recovery').hidden = c?.status !== 'needs_review';
  byId('timeline').toggleAttribute(
    'data-busy',
    ['running', 'queued', 'waiting', 'asking', 'needs_review'].includes(c?.status ?? ''),
  );
  renderAsk(c, (id, value) => rpc('answer', { id, value }).then(refresh).catch(showError));
  const serialized = JSON.stringify([
    selected,
    c?.messages,
    c?.draft,
    c?.turn?.call,
    c?.status,
    state.background.filter((job) => job.conversationId === selected).map((job) => job.state),
  ]);
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
    if (!foreground) {
      const draft = timeline.querySelector('[data-draft]');
      replacesDraft = Boolean(draft);
      draft?.remove();
    }
    if (!c?.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `<div class="welcome-mark" aria-hidden="true">${icon('spark')}</div><h2>What can we get done today?</h2><div class="starter"><div class="suggestions"></div></div><p class="preview-note">Preview uses sample replies. ChatGPT is not connected.</p>`;
      if (connectionState?.chatgpt.available) {
        const note = empty.querySelector('.preview-note')!;
        note.replaceChildren();
        if (!connectionState.chatgpt.connected && !customModel().chosen)
          note.append(button('Connect ChatGPT to start', openSetup, 'primary connect-start'));
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
      if (
        item.role === 'tool' &&
        item.tool === 'remember · local' &&
        item.text === 'Saved to memory.' &&
        item.createdAt > openedAt &&
        !announced.has(item.id)
      ) {
        announced.add(item.id);
        toast({
          key: 'memory',
          text: 'Saved to your memory',
          action: {
            label: 'Undo',
            run: () =>
              void rpc('memory', { undo: true })
                .then(() => rpc<unknown>('memoryChange'))
                .then((left) => {
                  toast({
                    key: 'memory',
                    text: left ? 'Memory changed since, so it was kept' : 'Memory restored',
                    ms: 3000,
                  });
                  return refreshSettingsData();
                })
                .catch(showError),
          },
        });
      }
      timeline
        .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)
        ?.toggleAttribute('data-queued', Boolean(item.queue));
      timeline
        .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)
        ?.toggleAttribute('data-unsent', Boolean(item.unsent));
      // Finished background work has no bubble, but its step needs a place in the chat.
      const hiddenActivity =
        isInternalActivity(item) && !item.id.startsWith('background-completed:');
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
    // While Kinetik works, its reply block is already there and says what it is doing.
    if (foreground) {
      let draft = timeline.querySelector<HTMLElement>('[data-draft]');
      if (!draft) {
        draft = document.createElement('article');
        draft.className = 'message streaming-message';
        draft.dataset.draft = 'true';
        // Re-rendered content would otherwise be re-announced in full on every frame.
        draft.setAttribute('aria-busy', 'true');
        // The live time rides on the name row, so the finished reply takes the same lines.
        draft.innerHTML = `<div class="message-label"><img src="./icon.svg" width="24" height="24" alt="" />Kinetik<span class="streaming-label">Writing</span><span class="draft-time"></span></div><div class="message-content streaming-content"></div>`;
        timeline.append(draft);
      }
      draftText = c!.draft ?? '';
      draftFrame ||= requestAnimationFrame(renderDraft);
    }
    const replies = timeline.querySelectorAll('.message[data-role=assistant]:not([data-draft])');
    replies.forEach((reply, index) =>
      reply.toggleAttribute('data-latest', index === replies.length - 1),
    );
    renderToolActivity(timeline, c, state.background);
    renderRuns(timeline, c, Boolean(c && busyChat(c)), state.background);
    timeline.scrollTop = !c?.messages.length
      ? 0
      : forceScroll || nearBottom
        ? timeline.scrollHeight
        : oldScroll;
  }
  const pending = byId('timeline').querySelector<HTMLElement>('[data-draft] .streaming-label');
  // Steps and the thinking note above already say what is happening; this only shows it is alive.
  if (pending && pending.dataset.writing !== String(Boolean(c?.draft))) {
    pending.dataset.writing = String(Boolean(c?.draft));
    pending.innerHTML = c?.draft
      ? 'Writing'
      : '<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    updateElapsed();
  }
  updateJumpButton();
  renderAutomations(state.automations, refresh, choose);
  setSettingsPlugins(state.plugins);
  setSettingsChats(state.conversations);
}
async function refresh() {
  const generation = ++refreshGeneration;
  const load = async () => {
    const value = await rpc<State>('state', { conversation: selected });
    return { ...value, conversations: value.conversations.filter((c) => !deleting.has(c.id)) };
  };
  // Only a newer reload already shown, or another chat opened meanwhile, makes this one stale.
  // So `await refresh()` leaves state read after the call: Send never sees an older tray.
  const stale = (chat: string) => generation < shownGeneration || chat !== selected;
  let chat = selected;
  let next = await load();
  if (stale(chat)) return;
  if (!next.conversations.some((c) => c.id === selected) && next.conversations.length) {
    selected = chat = next.conversations[0].id;
    next = await load();
    if (stale(chat)) return;
  }
  shownGeneration = generation;
  noticeFinished(state.conversations, next.conversations);
  state = next;
  if (unread().has(selected)) markRead(selected);
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
      reportFirstUse(true);
    } catch (error) {
      // Uploads and provider requests are external failures, not bundle failures.
      if (failureKind(error) === 'app') reportFirstUse(false);
      throw error;
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
/** Chats deleted but still undoable: hidden now, removed when their toast leaves. */
const deleting = new Map<string, () => void>();
byId('delete-chat').onclick = () => {
  const id = selected;
  const title = current()?.title ?? 'Chat';
  deleting.set(id, () => {
    deleting.delete(id);
    void rpc('delete', { id }).then(refresh).catch(showError);
  });
  selected = state.conversations.find((c) => c.id !== id && !deleting.has(c.id))?.id ?? '';
  void refresh().catch(showError);
  toast({
    text: `Deleted “${title}”`,
    ms: 8000,
    action: {
      label: 'Undo',
      run: () => {
        deleting.delete(id);
        choose(id);
      },
    },
    done: () => deleting.get(id)?.(),
  });
};
// Leaving the app ends the chance to undo; Android's WebView only reports it as hidden.
const commitDeletes = () => [...deleting.values()].forEach((remove) => remove());
addEventListener('pagehide', commitDeletes);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') commitDeletes();
});
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
let pinned = true;
byId('timeline').addEventListener(
  'scroll',
  () => {
    const timeline = byId('timeline');
    pinned = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    updateJumpButton();
  },
  { passive: true },
);
// The keyboard opening shrinks the chat; one that was at its end stays there.
new ResizeObserver(() => {
  if (pinned) byId('timeline').scrollTop = byId('timeline').scrollHeight;
  updateJumpButton();
}).observe(byId('timeline'));
// The header and composer float over the chat, which keeps their heights free at its ends.
const floating = new ResizeObserver(() => {
  const main = byId('main');
  main.style.setProperty('--topbar-height', `${main.querySelector('.topbar')!.clientHeight}px`);
  main.style.setProperty(
    '--composer-height',
    `${main.querySelector('.composer-area')!.clientHeight}px`,
  );
  if (pinned) byId('timeline').scrollTop = byId('timeline').scrollHeight;
});
for (const part of document.querySelectorAll('.topbar, .composer-area')) floating.observe(part);
byId('timeline').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('a, button, summary, details, iframe')) return;
  const message = target.closest<HTMLElement>(
    '.message[data-role=assistant], .message[data-role=user]',
  );
  if (!message || getSelection()?.toString()) return;
  for (const shown of byId('timeline').querySelectorAll('[data-show-actions]'))
    if (shown !== message) shown.removeAttribute('data-show-actions');
  message.toggleAttribute('data-show-actions');
});
byId('jump-latest').onclick = () => {
  const timeline = byId('timeline');
  timeline.scrollTo({
    top: timeline.scrollHeight,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  });
};
let refreshTimer: ReturnType<typeof setTimeout>;
let sidebarTimer: ReturnType<typeof setTimeout>;
/** Work in this chat is still going: a turn, or background work it started. */
function busyChat(c: Conversation) {
  return (
    ['running', 'queued', 'waiting', 'asking', 'needs_review'].includes(c.status) ||
    state.background.some((job) => job.conversationId === c.id)
  );
}
function updateElapsed() {
  const c = current();
  const now = Date.now();
  for (const time of byId('timeline').querySelectorAll<HTMLElement>('[data-started-at]'))
    time.textContent = took(now - Number(time.dataset.startedAt));
  const working = byId('timeline').querySelector('[data-draft] .draft-time');
  if (working && c?.turn?.startedAt !== undefined)
    working.textContent = elapsed(now - c.turn.startedAt);
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
window.addEventListener('kinetik-retry', (event) => {
  const id = (event as CustomEvent<string>).detail;
  if (id !== selected) return;
  followNextMessage = true;
  void rpc('submit', { id, text: 'Try again.', messageId: crypto.randomUUID() })
    .then(refresh)
    .catch(showError);
});
window.addEventListener('kinetik-changed', (event) =>
  changed((event as CustomEvent<RuntimeEvent | undefined>).detail),
);
window.addEventListener('kinetik-native-error', (event) =>
  showError((event as CustomEvent).detail),
);
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'changed') changed(event.data.event);
  if (event.data?.type === 'open-chat')
    window.dispatchEvent(new CustomEvent('kinetik-open-chat', { detail: event.data.id }));
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
  const updatesReady = registration ? setupUpdates(registration) : undefined;
  // Opened from a notification: show that chat.
  const opened = new URL(location.href).searchParams.get('chat');
  if (opened) {
    selected = opened;
    markRead(opened);
    const url = new URL(location.href);
    url.searchParams.delete('chat');
    history.replaceState(null, '', url);
  }
  await refresh();
  if (!registration)
    void import('./platform/updates')
      .then(({ setupNativeUpdates }) => setupNativeUpdates())
      .catch(() => {});
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
setupFiles(async (files) => {
  pickingFile = true;
  updateComposer();
  try {
    // One at a time keeps the chosen order and stops at the first file over the limits.
    for (const file of files) await stageFile({ name: file.name, bytes: await file.read() });
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
  setAppDetails(value.app);
  if (value.capabilities.routinesNeedOpenApp)
    byId('automation-hint').textContent =
      'Runs while Kinetik is open. Paused routines catch up once when you return.';
  setModelState({
    chatgpt: Boolean(value.chatgpt.connected && value.chatgpt.browser),
    hostChatgpt: Boolean(value.chatgpt.connected && !value.chatgpt.browser),
    model: value.chatgpt.model ?? '',
  });
  if (becameConnected) void resumeWork();
  updateConnectionStatus();
  byId('connection-status').innerHTML =
    icon('plug') +
    `<span>${value.chatgpt.available && !value.chatgpt.connected ? 'Connect' : 'Reconnect'}</span>`;
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
/** What needs connecting, in the header and the drawer; a chosen custom model needs no ChatGPT. */
function updateConnectionStatus() {
  const value = connectionState;
  if (!value) return;
  const attention =
    (value.chatgpt.available && !value.chatgpt.connected && !customModel().chosen) ||
    value.charms.status === 'reconnect';
  byId('connection-status').hidden = !attention;
  byId('connections-dot').dataset.attention = String(attention);
  const connected = [
    value.chatgpt.connected ? 'ChatGPT' : customModel().chosen ? 'Custom model' : '',
    value.charms.status === 'connected' ? 'Charms' : '',
  ].filter(Boolean);
  byId('connections-dot').hidden = !attention && !connected.length;
  byId('connections-summary').textContent = attention
    ? 'Needs attention'
    : connected.join(' · ') ||
      (value.charms.available || value.chatgpt.available ? 'Not connected' : 'Manage services');
}
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
