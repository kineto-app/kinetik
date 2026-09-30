import './ui/styles.css';
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

type State = {
  background: { id: string; conversationId: string; tool: string }[];
  automations: Automation[];
  conversations: Conversation[];
  plugins: Pick<InstalledPlugin, 'manifest' | 'source' | 'enabledAt' | 'digest'>[];
};
const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = shell;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: State = { conversations: [], plugins: [], automations: [], background: [] };
let selected = sessionStorage.getItem('kinetik-conversation') ?? '';
let refreshGeneration = 0;
let lastMessages = '';
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
    hint.textContent = 'A little space for each idea.';
    nav.append(hint);
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
  byId('stop').hidden =
    c?.status !== 'running' && !jobs.some((job) => job.conversationId === selected);
  byId('status').dataset.state = c?.status ?? 'idle';
  byId('activity').hidden = !foreground;
  byId('activity-label').textContent =
    c?.call?.state === 'pending' ? taskLabel(c.call.name) : 'Working on your message';
  byId('recovery').hidden = c?.status !== 'needs_review';
  const serialized = JSON.stringify([selected, c?.messages, c?.draft]);
  if (serialized !== lastMessages) {
    const forceScroll = !lastMessages;
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
    timeline.querySelector('[data-draft]')?.remove();
    if (!c?.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `<h2>What would you like a hand with?</h2><p>Try a sample task. Make a file you can keep.<br class="desktop-break" /> Your chats and files stay in this browser.</p><div class="panel starter"><h3 class="section-label">Try an example</h3><div class="suggestions section-body"></div></div><p class="preview-note">This preview uses sample replies. Open-ended AI chat and ChatGPT sign-in are not connected yet.</p>`;
      const examples: [string, string, IconName, string][] = [
        ...demoTasks.map((task): [string, string, IconName, string] => [
          task.title,
          task.description,
          'file',
          task.prompt,
        ]),
        ['Find my files', 'See what you’ve saved here', 'folder', 'Show my saved files.'],
      ];
      for (const [label, description, glyph, text] of examples) {
        const action = button(
          '',
          () => {
            byId<HTMLTextAreaElement>('prompt').value = text;
            updateComposer();
            byId('prompt').focus();
          },
          'action-row',
        );
        action.innerHTML = `<span class="glyph">${icon(glyph)}</span><span class="action-main"><span class="action-title">${label}</span><span class="field-hint">${description}</span></span>${icon('chevron')}`;
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
      article.className = 'message';
      article.dataset.role = item.role;
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent =
        item.role === 'user'
          ? 'You'
          : item.role === 'assistant'
            ? 'Kinetik'
            : (item.tool ?? 'Workspace notice');
      const content = document.createElement('pre');
      content.textContent = item.text;
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
          card.append(name, actions);
          article.append(card);
        }
      } else article.append(label, content);
      timeline.append(article);
      if (item.app && c) disposeApps.push(mountApp(article, item.app, c.id));
    }
    if (c?.draft && !isBackgroundTurn(c)) {
      const draft = document.createElement('pre');
      draft.className = 'message';
      draft.dataset.draft = 'true';
      draft.textContent = c.draft;
      timeline.append(draft);
    }
    timeline.scrollTop = !c?.messages.length
      ? 0
      : forceScroll || nearBottom
        ? timeline.scrollHeight
        : oldScroll;
  }
  renderAutomations(state.automations, refresh, choose);
  byId('plugin-count').textContent = String(
    state.plugins.filter((p) => p.enabledAt !== null).length,
  );
  const list = byId('plugin-list');
  list.replaceChildren();
  if (!state.plugins.length)
    list.innerHTML = `<div class="plugins-empty">${icon('plug')}<div><strong>No connections yet</strong><p class="field-hint">Add a service when you need more help.</p></div></div>`;
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
  byId<HTMLButtonElement>('send').disabled = submitting || !input.value.trim();
  sessionStorage.setItem(draftKey, input.value);
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
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
    ];
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
byId('composer').onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    const input = byId<HTMLTextAreaElement>('prompt');
    const text = input.value;
    if (!text.trim() || submitting) return;
    submitting = true;
    updateComposer();
    try {
      if (!current()) selected = (await rpc<Conversation>('create')).id;
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
byId('stop').onclick = () => {
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
