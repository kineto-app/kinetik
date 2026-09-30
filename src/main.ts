import './ui/styles.css';
import { connect, rpc } from './browser/client';
import type { Conversation, InstalledPlugin } from './core/types';

type State = {
  conversations: Conversation[];
  plugins: Pick<InstalledPlugin, 'manifest' | 'source' | 'enabledAt' | 'digest'>[];
};
const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `
<div class="layout">
  <aside class="sidebar" aria-label="Conversations">
    <div class="brand"><img src="./icon.svg" alt="" /><span>Kinetik</span><small>OSS</small></div>
    <button class="secondary" id="new-chat">＋ New conversation</button>
    <nav id="conversations" aria-label="Conversation list"></nav>
    <div class="sidebar-footer"><button id="plugins-open">Plugins</button><button id="files-open">Import or export files</button><small>Shared local workspace<br />Stored in this browser</small></div>
  </aside>
  <main class="main">
    <header class="topbar"><button id="menu" aria-label="Toggle conversations">☰</button><h1 id="title">New conversation</h1><span class="status" id="status">Starting worker</span></header>
    <section id="timeline" aria-label="Conversation" aria-live="polite"></section>
    <section class="composer-area">
      <div id="recovery" hidden><p>A tool's outcome is unknown. Check its effects before continuing.</p><button class="secondary" id="resolve">Continue without retry</button><button id="retry">Retry the tool</button></div>
      <div id="error" role="alert"></div>
      <form id="composer" class="composer"><textarea id="prompt" aria-label="Message" placeholder="Try /exec echo hello" rows="2" maxlength="16384"></textarea><div class="composer-actions"><span class="small muted">Local test model</span><div><button type="button" id="stop" hidden>Stop</button><button class="primary" id="send" type="submit">Send</button></div></div></form>
      <p class="disclosure">Prototype with a mock model. No messages are sent to OpenAI.</p>
    </section>
  </main>
</div>
<dialog id="plugins-dialog" aria-labelledby="plugins-heading">
  <div class="dialog-head"><h2 id="plugins-heading">Plugins</h2><button data-close="plugins-dialog" aria-label="Close plugins">✕</button></div>
  <p class="muted">Add tools and native skills. Plugins run as trusted code and can access this app’s data. The last enabled replacement wins.</p>
  <div id="plugin-list"></div>
  <form id="plugin-form"><label for="plugin-source">Manifest, GitHub folder, or file URL</label><input id="plugin-source" type="url" required placeholder="https://example.org/plugin.json" /><label for="plugin-settings">Settings, JSON string values</label><textarea id="plugin-settings" spellcheck="false">{}</textarea><p class="small muted">An example plugin is included. It replaces exec and supplies a native skill.</p><button type="button" id="example">Use example URL</button><button class="primary" type="submit">Install plugin</button></form>
  <p id="plugin-error" class="dialog-error" role="alert"></p>
  <p class="small muted">Code updates are manual. Skills refresh before every message.</p>
</dialog>
<dialog id="files-dialog" aria-labelledby="files-heading">
  <div class="dialog-head"><h2 id="files-heading">Local files</h2><button data-close="files-dialog" aria-label="Close files">✕</button></div>
  <p class="muted">All conversations share /workspace. These controls always use local files, even when a plugin replaces workspace tools.</p>
  <label for="upload">Import into /workspace</label><input type="file" id="upload" />
  <form id="download-form"><label for="download-path">File to download</label><input id="download-path" value="/workspace/note.txt" required /><p><button class="primary">Download file</button></p></form>
  <p id="file-result" role="status"></p>
</dialog>`;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: State = { conversations: [], plugins: [] };
let selected = sessionStorage.getItem('kinetik-conversation') ?? '';
let refreshGeneration = 0;
let lastMessages = '';
const current = () => state.conversations.find((c) => c.id === selected);
function showError(error: unknown, target = 'error') {
  byId(target).textContent = error instanceof Error ? error.message : String(error);
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
  byId('sidebar')?.classList.remove('open');
  document.querySelector('.sidebar')?.classList.remove('open');
}
function render() {
  const nav = byId('conversations');
  nav.replaceChildren();
  for (const c of state.conversations) {
    const entry = button(
      (c.status === 'running' ? '• ' : '') + c.title,
      () => choose(c.id),
      'conversation',
    );
    entry.setAttribute('aria-current', String(c.id === selected));
    nav.append(entry);
  }
  const c = current();
  byId('title').textContent = c?.title ?? 'New conversation';
  byId('status').textContent =
    c?.status === 'running'
      ? 'Working locally'
      : c?.status === 'needs_review'
        ? 'Needs review'
        : 'Local workspace';
  byId('stop').hidden = c?.status !== 'running';
  byId('recovery').hidden = c?.status !== 'needs_review';
  const serialized = JSON.stringify([selected, c?.messages]);
  if (serialized !== lastMessages) {
    lastMessages = serialized;
    const timeline = byId('timeline');
    timeline.replaceChildren();
    if (!c?.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        '<img src="./icon.svg" alt="" /><h2>A little space to get things done.</h2><p>Your files, tools, and conversations, right here in the browser. Try the local workspace while we build the agent.</p><div class="suggestions"></div>';
      const examples = [
        ['Create a note', '/write /workspace/note.txt\nHello from Kinetik.'],
        ['Try the shell', '/exec printf "hello from the browser\\n" | tr a-z A-Z'],
        ['Explore native skills', '/skills'],
      ];
      for (const [label, text] of examples)
        empty.querySelector('.suggestions')!.append(
          button(label, () => {
            byId<HTMLTextAreaElement>('prompt').value = text;
            byId('prompt').focus();
          }),
        );
      timeline.append(empty);
    }
    for (const item of c?.messages ?? []) {
      const article = document.createElement('article');
      article.className = 'message';
      article.dataset.role = item.role;
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent =
        item.role === 'user'
          ? 'You'
          : item.role === 'assistant'
            ? 'Kinetik · local test model'
            : (item.tool ?? 'Workspace notice');
      const content = document.createElement('pre');
      content.textContent = item.text;
      article.append(label, content);
      timeline.append(article);
    }
    timeline.scrollTop = timeline.scrollHeight;
  }
  const list = byId('plugin-list');
  list.replaceChildren();
  for (const plugin of state.plugins) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const name = document.createElement('strong');
    name.textContent = plugin.manifest.name;
    const version = document.createElement('p');
    version.className = 'small muted';
    version.textContent = `${plugin.manifest.version} · ${plugin.enabledAt === null ? 'Disabled' : 'Enabled, priority ' + plugin.enabledAt}`;
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
  render();
}
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
    if (!text.trim()) return;
    if (!current()) selected = (await rpc<Conversation>('create')).id;
    await rpc('submit', { id: selected, text });
    input.value = '';
    byId('error').textContent = '';
    await refresh();
    input.focus();
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
for (const name of ['plugins', 'files'])
  byId(name + '-open').onclick = () => byId<HTMLDialogElement>(name + '-dialog').showModal();
for (const close of document.querySelectorAll<HTMLButtonElement>('[data-close]'))
  close.onclick = () => byId<HTMLDialogElement>(close.dataset.close!).close();
byId('menu').onclick = () => document.querySelector('.sidebar')!.classList.toggle('open');
byId('example').onclick = () => {
  byId<HTMLInputElement>('plugin-source').value = new URL(
    'plugins/example/plugin.json',
    document.baseURI,
  ).href;
};
byId('plugin-form').onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    byId('plugin-error').textContent = 'Installing…';
    await rpc('install', {
      source: byId<HTMLInputElement>('plugin-source').value,
      settings: byId<HTMLTextAreaElement>('plugin-settings').value,
    });
    byId('plugin-error').textContent =
      'Installed. Enable the plugin to activate its tools and skills.';
    await refresh();
  })().catch((error) => showError(error, 'plugin-error'));
};
byId('upload').onchange = () => {
  void (async () => {
    const file = byId<HTMLInputElement>('upload').files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw new Error('Maximum import size is 4 MiB.');
    await rpc('import', { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    byId('file-result').textContent = 'Imported /workspace/' + file.name;
  })().catch((error) => showError(error, 'file-result'));
};
byId('download-form').onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    const path = byId<HTMLInputElement>('download-path').value;
    const bytes = await rpc<Uint8Array>('export', { path });
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('/').pop() || 'download';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    byId('file-result').textContent = 'Downloaded ' + path;
  })().catch((error) => showError(error, 'file-result'));
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
  await refresh();
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
void start().catch(showError);
