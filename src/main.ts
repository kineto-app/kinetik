import { setupViewport } from './browser/viewport';
import { renderToolActivity } from './ui/tool-activity';
import './ui/styles.css';
import './ui/chat.css';
import './ui/islands.css';
import { renderMessageContent, copyButton } from './ui/message-content';
import { mountApp } from './ui/mcp-app';
import { setupAutomations, renderAutomations } from './ui/automations';
import type { Automation } from './core/automation';
import { shell } from './ui/shell';
import { icon, type IconName } from './ui/icons';
import { demoTasks } from './core/demo-tasks';
import { taskLabel } from './ui/task-labels';
import { setupFiles, refreshFiles, previewFile, downloadFile } from './ui/files';
import { setupUpdates } from './browser/updates';
import { connect, rpc } from './browser/client';
import type { Conversation, InstalledPlugin } from './core/types';
import { setupConnections } from './ui/onboarding';
import type { SetupState } from './connections/manager';

type State = {
  background: { id: string; conversationId: string; tool: string; state: string }[];
  automations: Automation[];
  conversations: Conversation[];
  plugins: Pick<InstalledPlugin, 'manifest' | 'source' | 'enabledAt' | 'digest'>[];
};
const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = shell;
setupViewport();
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: State = { conversations: [], plugins: [], automations: [], background: [] };
let connectionState: SetupState | undefined;
let selected = sessionStorage.getItem('kinetik-conversation') ?? '';
let refreshGeneration = 0;
let lastMessages = '';
let lastNavigation = '';
let followNextMessage = false;
let disposeApps: (() => void)[] = [];
let timelineConversation = '';
const renderedMessages = new Set<string>();
const draftKey = 'kinetik-composer';
byId<HTMLTextAreaElement>('prompt').value = sessionStorage.getItem(draftKey) ?? '';
const isBackgroundTurn = (c: Conversation) => {
  if (c.turn) return c.turn === 'background';
  const active = c.messages.find((m) => m.id === (c.activeMessage ?? c.pending[0]));
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
  sessionStorage.setItem('kinetik-conversation', id);
  lastMessages = '';
  render();
  closeDrawer(false);
  byId('prompt').focus();
}
function render() {
  const nav = byId('conversations');
  const navigation = JSON.stringify([
    selected,
    state.conversations.map((c) => [c.id, c.title, c.status, isBackgroundTurn(c)]),
  ]);
  if (navigation !== lastNavigation) {
    lastNavigation = navigation;
    nav.replaceChildren();
    for (const c of state.conversations) {
      const entry = button(
        (c.status === 'running' && !isBackgroundTurn(c) ? '• ' : '') + c.title,
        () => choose(c.id),
        'conversation',
      );
      entry.setAttribute('aria-current', String(c.id === selected));
      nav.append(entry);
    }
    if (!state.conversations.length) {
      const hint = document.createElement('p');
      hint.className = 'history-empty';
      hint.textContent = 'No chats yet.';
      nav.append(hint);
    }
  }
  const c = current();
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
  byId('status').textContent = foreground
    ? 'Working…'
    : c?.status === 'needs_review'
      ? 'Needs review'
      : 'Ready';
  byId('composer-hint').textContent = foreground
    ? 'Send another message to guide Kinetik as it works.'
    : 'Enter to send · Shift + Enter for a new line';
  byId('connection-wait').hidden = c?.status !== 'waiting';
  byId('connection-wait-label').textContent =
    c?.waitingFor === 'signin' ? 'Sign in to continue' : 'Connection interrupted';
  byId('resume-work').textContent = c?.waitingFor === 'signin' ? 'Sign in' : 'Retry';
  updateComposer();
  byId('status').dataset.state = c?.status ?? 'idle';
  byId('activity').hidden = !foreground;
  byId('activity-label').textContent =
    c?.call?.state === 'pending' ? taskLabel(c.call.name) : 'Working on your message';
  byId('recovery').hidden = c?.status !== 'needs_review';
  const serialized = JSON.stringify([selected, c?.messages, c?.draft, c?.call, c?.status]);
  if (serialized !== lastMessages) {
    const forceScroll = !lastMessages || followNextMessage;
    followNextMessage = false;
    lastMessages = serialized;
    const timeline = byId('timeline');
    const oldScroll = timeline.scrollTop;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    if (timelineConversation !== selected || !c?.messages.length) {
      disposeApps.forEach((dispose) => dispose());
      disposeApps = [];
      renderedMessages.clear();
      timeline.replaceChildren();
      timelineConversation = selected;
    }
    if (c?.messages.length) timeline.querySelector('.empty')?.remove();
    if (!c?.draft || isBackgroundTurn(c)) timeline.querySelector('[data-draft]')?.remove();
    if (!c?.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `<div class="welcome-mark" aria-hidden="true">${icon('spark')}</div><h2>What can we get done today?</h2><div class="starter"><div class="suggestions"></div></div><p class="preview-note">Preview uses sample replies. ChatGPT is not connected.</p>`;
      if (connectionState?.chatgpt.available) {
        empty.querySelector('.preview-note')!.textContent = connectionState.chatgpt.connected
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
      if (
        item.visibility === 'internal' ||
        item.id.startsWith('background-completed:') ||
        item.tool?.startsWith('background ·') ||
        renderedMessages.has(item.id)
      )
        continue;
      renderedMessages.add(item.id);
      const article = document.createElement('article');
      article.className = 'message message-enter';
      article.dataset.role = item.role;
      article.dataset.messageId = item.id;
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent =
        item.role === 'user'
          ? 'You'
          : item.role === 'assistant'
            ? 'Kinetik'
            : (item.tool ?? 'Workspace notice');
      const content =
        item.role === 'assistant' ? renderMessageContent(item.text) : document.createElement('pre');
      content.classList.add('message-content');
      if (item.role !== 'assistant') content.textContent = item.text;
      if (item.role === 'assistant') {
        const avatar = document.createElement('img');
        avatar.src = './icon.svg';
        avatar.alt = '';
        avatar.width = 24;
        avatar.height = 24;
        label.prepend(avatar);
      }
      if (item.role === 'tool') {
        const mark = document.createElement('span');
        mark.className = 'tool-mark';
        mark.innerHTML = icon('check');
        label.prepend(mark);
      }
      if (item.role === 'tool') {
        const details = document.createElement('details');
        details.className = 'tool-details';
        const summary = document.createElement('summary');
        summary.textContent = taskLabel(item.tool ?? '', true);
        details.append(summary, label, content);
        article.append(details);
        if (item.file) {
          const file = item.file;
          const card = document.createElement('div');
          card.className = 'file-card';
          const name = document.createElement('strong');
          name.textContent = file.name;
          const actions = document.createElement('div');
          actions.className = 'actions';
          actions.append(
            button(
              'Open',
              async () => {
                openDialog('files');
                await previewFile(file.path);
              },
              'secondary',
            ),
            button('Download', () => downloadFile(file.path)),
          );
          const fileIcon = document.createElement('span');
          fileIcon.className = 'glyph';
          fileIcon.innerHTML = icon('file');
          card.append(fileIcon, name, actions);
          article.append(card);
        }
      } else {
        article.append(label, content);
        if (item.role === 'assistant') {
          const actions = document.createElement('div');
          actions.className = 'message-actions';
          actions.append(copyButton(item.text, 'Copy reply'));
          article.append(actions);
        }
      }
      timeline.insertBefore(article, timeline.querySelector('[data-draft]'));
      if (item.app && c) disposeApps.push(mountApp(article, item.app, c.id));
    }
    if (c?.draft && !isBackgroundTurn(c)) {
      let draft = timeline.querySelector<HTMLElement>('[data-draft]');
      if (!draft) {
        draft = document.createElement('article');
        draft.className = 'message streaming-message';
        draft.dataset.draft = 'true';
        draft.innerHTML = `<div class="message-label"><img src="./icon.svg" width="24" height="24" alt="" />Kinetik<span class="streaming-label">Writing</span></div><div class="message-content streaming-content"></div>`;
        timeline.append(draft);
      }
      const content = draft.querySelector('.message-content')!;
      const text = content.firstChild;
      if (text instanceof Text && c.draft.startsWith(text.data)) {
        text.appendData(c.draft.slice(text.data.length));
      } else content.textContent = c.draft;
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
  byId('plugin-count').textContent = String(
    state.plugins.filter((p) => p.enabledAt !== null).length,
  );
  const list = byId('plugin-list');
  list.replaceChildren();
  if (!state.plugins.length)
    list.innerHTML = `<div class="plugins-empty">${icon('plug')}<div><strong>No connections yet</strong></div></div>`;
  for (const plugin of state.plugins) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const name = document.createElement('strong');
    name.textContent = plugin.manifest.name;
    const version = document.createElement('p');
    version.className = 'small muted';
    version.textContent = `${plugin.manifest.version} · ${plugin.enabledAt === null ? 'Off' : 'On'}`;
    const actions = document.createElement('div');
    actions.className = 'plugin-actions';
    actions.append(
      button(
        plugin.enabledAt === null ? 'Enable' : 'Disable',
        async () => {
          await rpc('enable', { id: plugin.manifest.id, enabled: plugin.enabledAt === null });
          await refresh();
        },
        'secondary',
      ),
    );
    actions.append(
      button('Update', async () => {
        try {
          await rpc('update', { id: plugin.manifest.id });
          await refresh();
        } catch (error) {
          showError(error, 'plugin-error');
        }
      }),
    );
    row.append(name, version, actions);
    list.append(row);
  }
}
async function refresh() {
  const generation = ++refreshGeneration;
  const next = await rpc<State>('state');
  if (generation !== refreshGeneration) return;
  state = next;
  if (!current() && state.conversations.length) selected = state.conversations[0].id;
  sessionStorage.setItem('kinetik-conversation', selected);
  render();
}
let submitting = false;
function updateComposer() {
  const input = byId<HTMLTextAreaElement>('prompt');
  const busy =
    ['running', 'queued', 'waiting'].includes(current()?.status ?? '') ||
    state.background.some((job) => job.conversationId === selected);
  const stopping = busy && !input.value.trim();
  byId('stop').hidden = !stopping;
  byId('send').hidden = stopping;
  byId('work-options').hidden = !busy;
  if (!busy) byId<HTMLDetailsElement>('work-options').open = false;
  byId<HTMLButtonElement>('send').disabled = submitting || !input.value.trim();
  sessionStorage.setItem(draftKey, input.value);
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 144) + 'px';
}
byId('prompt').addEventListener('input', updateComposer);
const narrow = matchMedia('(max-width: 700px)');
function closeDrawer(restoreFocus = true) {
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
function openDrawer() {
  byId('sidebar').inert = false;
  byId('sidebar').classList.add('open');
  byId('sidebar').setAttribute('role', 'dialog');
  byId('sidebar').setAttribute('aria-modal', 'true');
  byId('main').inert = true;
  byId('drawer-scrim').hidden = false;
  byId('menu').setAttribute('aria-expanded', 'true');
  byId('menu-close').focus();
}
narrow.addEventListener('change', () => closeDrawer(false));
closeDrawer(false);
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
byId('new-chat').onclick = () => {
  void (async () => {
    const c = await rpc<Conversation>('create');
    selected = c.id;
    await refresh();
    choose(c.id);
    byId('prompt').focus();
  })().catch(showError);
};
byId('top-new-chat').onclick = () => byId('new-chat').click();
byId('composer').onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    const input = byId<HTMLTextAreaElement>('prompt');
    const text = input.value;
    if (!text.trim() || submitting) return;
    submitting = true;
    updateComposer();
    try {
      if (connectionState?.chatgpt.available) {
        await connectionSetup.refresh();
        if (!connectionState.chatgpt.connected) {
          connectionSetup.open();
          return;
        }
      }
      if (!current()) selected = (await rpc<Conversation>('create')).id;
      followNextMessage = true;
      await rpc('submit', { id: selected, text });
      input.value = '';
      updateComposer();
      byId('error').textContent = '';
      await refresh();
      input.focus();
    } finally {
      submitting = false;
      updateComposer();
    }
  })().catch(showError);
};
byId('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    byId<HTMLFormElement>('composer').requestSubmit();
  }
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
function openDialog(name: string) {
  closeDrawer();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  byId<HTMLDialogElement>(name + '-dialog').showModal();
  if (name === 'files') void refreshFiles().catch((error) => showError(error, 'file-result'));
}
for (const name of ['plugins', 'files', 'automations', 'settings'])
  byId(name + '-open').onclick = () => openDialog(name);
byId('attach').onclick = () => openDialog('files');
for (const close of document.querySelectorAll<HTMLButtonElement>('[data-close]'))
  close.onclick = () => byId<HTMLDialogElement>(close.dataset.close!).close();
byId('menu').onclick = openDrawer;
byId('menu-close').onclick = () => closeDrawer();
byId('drawer-scrim').onclick = () => closeDrawer();
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
      await rpc('install', {
        source: byId<HTMLInputElement>('plugin-source').value,
        settings: byId<HTMLTextAreaElement>('plugin-settings').value,
      });
      byId('plugin-error').textContent = 'Added. Choose Enable to let Kinetik use this connection.';
      byId('plugin-error').dataset.kind = 'success';
      await refresh();
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
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'changed') {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refresh().catch(showError);
    }, 30);
  }
});
async function start() {
  const registration = await connect();
  const updatesReady = setupUpdates(registration);
  await refresh();
  await connectionSetup.initialize();
  await rpc('resume');
  await rpc('tick');
  await updatesReady;
  // The build is complete before the one-shot local launcher is allowed to exit.
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
setupFiles();
setupAutomations(refresh);
const connectionSetup = setupConnections((value) => {
  if (JSON.stringify(connectionState) === JSON.stringify(value)) return;
  const becameConnected =
    (value.chatgpt.connected && !connectionState?.chatgpt.connected) ||
    (value.charms.status === 'connected' && connectionState?.charms.status !== 'connected');
  connectionState = value;
  if (becameConnected) void resumeWork();
  const configured = value.charms.available || value.chatgpt.available;
  byId('connection-status').hidden = !configured;
  byId('managed-section').hidden = !configured;
  byId('connection-status').innerHTML = icon('plug');
  byId('connection-status').classList.add('icon-button');
  byId('connection-status').title =
    value.charms.status === 'connected' ? 'Charms connected' : 'Connections';
  byId('connection-status').dataset.connected = String(value.charms.status === 'connected');
  byId('charms-state').textContent =
    value.charms.status === 'connected'
      ? 'Connected · cloud workspace'
      : value.charms.status === 'disabled'
        ? 'Disabled'
        : value.charms.status === 'reconnect'
          ? 'Reconnect to continue'
          : 'Not connected';
  byId('chatgpt-state').textContent = value.chatgpt.connected
    ? 'Connected'
    : value.chatgpt.available
      ? 'Not connected'
      : 'Unavailable on this host';
  byId('connection-disconnect').hidden = !['connected', 'disabled', 'reconnect'].includes(
    value.charms.status,
  );
  byId('chatgpt-disconnect').hidden = !value.chatgpt.connected;
  if (value.chatgpt.available) {
    byId('model-label').textContent = 'ChatGPT';
    byId('model-status').textContent = value.chatgpt.connected
      ? 'ChatGPT subscription'
      : 'Connect ChatGPT to chat';
    byId('model-settings-title').textContent = 'ChatGPT subscription';
    byId('model-settings-description').textContent = value.chatgpt.browser
      ? 'Sign-in lasts for this browser session. If it ends, sign in again.'
      : 'Your account connection is managed by this host’s credential helper. Your agent and tools run in this browser.';
  }
  if (!current()?.messages.length) lastMessages = '';
  render();
});
for (const id of ['connection-status', 'connection-open', 'chatgpt-open'])
  byId(id).onclick = () => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
      dialog.close();
    connectionSetup.open();
  };
byId('connection-disconnect').onclick = () => {
  void connectionSetup
    .disconnectCharms()
    .then(refresh)
    .catch((e) => showError(e, 'error'));
};
byId('chatgpt-disconnect').onclick = () => {
  void connectionSetup.disconnectChatGPT().catch((e) => showError(e, 'error'));
};
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
  if (current()?.waitingFor === 'signin') connectionSetup.open();
  else void resumeWork();
};
window.addEventListener('online', () => {
  void resumeWork();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void resumeWork();
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
