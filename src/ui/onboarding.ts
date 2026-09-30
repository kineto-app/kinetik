import { rpc } from '../browser/client';
import type { SetupState } from '../connections/manager';
import { icon } from './icons';
import './onboarding.css';

const initial: SetupState = {
  charms: { available: false, status: 'not-connected' },
  chatgpt: { available: false, connected: false },
};

export function setupConnections(changed: (state: SetupState) => void) {
  let state = initial;
  let busy = false;
  let screen: 'charms' | 'chatgpt' | 'ready' = 'charms';
  let signingIn = false;
  const url = new URL(location.href);
  const requested = url.searchParams.get('connect');
  const callback =
    url.searchParams.get('connection_callback') === 'charms'
      ? {
          state: url.searchParams.get('state') ?? '',
          code: url.searchParams.get('code') ?? '',
          error: url.searchParams.get('error') ?? '',
          issuer: url.searchParams.get('iss') ?? '',
        }
      : undefined;
  if (requested || callback) {
    for (const key of [
      'connect',
      'connection_callback',
      'state',
      'code',
      'error',
      'error_description',
      'iss',
    ])
      url.searchParams.delete(key);
    history.replaceState(null, '', url);
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'connection-setup';
  dialog.className = 'connection-setup';
  dialog.setAttribute('aria-labelledby', 'setup-title');
  dialog.innerHTML = `
    <header class="setup-nav"><div class="brand"><img src="./icon.svg" width="34" height="34" alt=""/>Kinetik</div><button id="setup-later" class="setup-quiet">Set up later</button></header>
    <div class="setup-body">
      <section class="setup-main">
        <ol class="setup-steps" aria-label="Connection progress"><li data-step="charms"><span>1</span>Charms</li><li data-step="chatgpt"><span>2</span>ChatGPT</li><li data-step="ready"><span>3</span>Ready</li></ol>
        <p class="setup-eyebrow" id="setup-eyebrow">Your workspace</p>
        <h1 id="setup-title" tabindex="-1">Give your assistant the tools to help.</h1>
        <p id="setup-description" class="setup-lead"></p>
        <div id="setup-charms">
          <div class="setup-benefits">
            <div>${icon('folder')}<div><strong>A workspace for your work</strong><p>Create and edit files in your Charms workspace.</p></div></div>
            <div>${icon('spark')}<div><strong>Your skills, ready to use</strong><p>Kinetik finds and updates them automatically.</p></div></div>
            <div>${icon('check')}<div><strong>You’re in control</strong><p>Review access in Kineto before you connect.</p></div></div>
          </div>
          <button id="setup-connect-charms" class="primary setup-primary">Connect Charms ${icon('external')}</button>
          <p id="setup-charms-hint" class="setup-hint">Opens Kineto, then brings you back here.</p>
        </div>
        <div id="setup-chatgpt" hidden>
          <div id="setup-helper-missing" class="setup-notice" hidden>ChatGPT sign-in isn’t available on this host yet. Your Charms connection is saved. You can explore Kinetik and return when sign-in is available.</div>
          <button id="setup-login" class="primary setup-primary">Continue with ChatGPT ${icon('external')}</button>
          <div id="setup-callback" hidden>
            <ol class="setup-instructions"><li><div><strong>Sign in to ChatGPT in the new tab.</strong><a id="setup-authorize" target="_blank" rel="noopener noreferrer">Open sign-in page again ${icon('external')}</a></div></li>
            <li><div><strong>Copy the full address after sign-in.</strong><p>The final page may say it can’t be reached. That’s expected. Copy its address, not the page text.</p><div class="setup-address">127.0.0.1:1455/auth/callback?code=…</div></div></li>
            <li><div><strong>Return here and paste the address below.</strong></div></li></ol>
            <form id="setup-callback-form"><label for="setup-return-link">Return link from your browser</label><input id="setup-return-link" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:1455/auth/callback?…" aria-describedby="setup-error"/><button id="setup-finish" class="primary setup-primary" type="submit">Connect ChatGPT ${icon('check')}</button></form>
          </div>
          <button id="setup-back" class="setup-quiet">Back to Charms</button>
        </div>
        <div id="setup-ready" hidden><div class="setup-ready-list"><p id="setup-charms-ready">${icon('check')}<span>Charms tools and skills</span><strong>Connected</strong></p><p>${icon('check')}<span>ChatGPT subscription</span><strong>Connected</strong></p></div><button id="setup-start" class="primary setup-primary">Start chatting ${icon('chevron')}</button></div>
        <p id="setup-progress" class="setup-hint" role="status"></p>
        <p id="setup-error" class="setup-error" role="alert" hidden></p>
        <button id="setup-retry" class="secondary" hidden>Try again</button>
      </section>
      <aside class="setup-example" aria-label="Example conversation"><p class="setup-eyebrow">From a thought to a first draft</p><div class="setup-example-user">Help me plan a relaxed weekend in Amsterdam.</div><div class="setup-example-reply"><div class="brand"><img src="./icon.svg" width="28" height="28" alt=""/>Kinetik</div><p>A few good places, room to wander, and everything in one handy plan.</p><div class="setup-example-file">${icon('file')}<div><strong>Amsterdam weekend</strong><small>Your itinerary · ready to open</small></div></div></div><p class="setup-hint">An example of what you can make</p></aside>
    </div><footer class="setup-footer">Your accounts stay separate. You can disconnect either one at any time.</footer>`;
  document.body.append(dialog);
  const $ = <T extends HTMLElement>(id: string) => dialog.querySelector<T>('#setup-' + id)!;
  function error(value: unknown) {
    $('error').textContent = value instanceof Error ? value.message : String(value);
    $('error').hidden = false;
  }
  function clearError() {
    $('error').hidden = true;
    $('return-link').removeAttribute('aria-invalid');
  }
  function go(next: typeof screen, focus = true) {
    screen = next;
    clearError();
    for (const name of ['charms', 'chatgpt', 'ready']) $(name).hidden = name !== next;
    for (const li of dialog.querySelectorAll<HTMLElement>('[data-step]')) {
      if (li.dataset.step === next) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    }
    $('eyebrow').textContent = {
      charms: 'Your workspace',
      chatgpt: 'Your conversation',
      ready: 'All connected',
    }[next];
    $('title').textContent = {
      charms: 'Give your assistant the tools to help.',
      chatgpt: 'Bring your ChatGPT subscription.',
      ready: 'What can we get done today?',
    }[next];
    $('description').textContent = {
      charms:
        'Connect Charms to turn a conversation into useful work, with your files and skills in one place.',
      chatgpt:
        state.charms.status === 'connected'
          ? 'Sign in to start talking with Kinetik. Your Charms workspace is already connected.'
          : 'Sign in to start talking with Kinetik using your ChatGPT subscription.',
      ready:
        'Your assistant has the tools and skills to get started. Tell Kinetik what you have in mind.',
    }[next];
    $('charms-ready').hidden = state.charms.status !== 'connected';
    $('back').hidden = !state.charms.available;
    $('helper-missing').textContent =
      'ChatGPT sign-in isn’t available on this host yet. You can explore Kinetik and return when sign-in is available.';
    $('helper-missing').hidden = state.chatgpt.available;
    $('login').hidden = !state.chatgpt.available || state.chatgpt.connected;
    $('callback').hidden = !signingIn;
    $('connect-charms').innerHTML =
      (state.charms.status === 'connected'
        ? 'Continue'
        : state.charms.status === 'disabled'
          ? 'Enable Charms'
          : state.charms.status === 'reconnect'
            ? 'Reconnect Charms'
            : 'Connect Charms') + icon('external');
    $('charms-hint').textContent = state.charms.available
      ? 'Opens Kineto, then brings you back here.'
      : 'Charms is not configured on this host.';
    $<HTMLButtonElement>('connect-charms').disabled = !state.charms.available;
    if (focus && dialog.open) {
      $('title').focus();
      dialog.scrollTop = 0;
    }
  }
  function next() {
    go(
      state.charms.available && state.charms.status !== 'connected'
        ? 'charms'
        : state.chatgpt.connected
          ? 'ready'
          : 'chatgpt',
    );
  }
  function open() {
    next();
    if (!dialog.open) dialog.showModal();
    $('title').focus();
  }
  function close() {
    dialog.close();
    sessionStorage.removeItem('kinetik-setup');
    document.getElementById('prompt')?.focus();
  }
  async function refresh() {
    state = await rpc<SetupState>('setupState');
    changed(state);
  }
  async function run(work: () => Promise<void>, progress: string) {
    if (busy) return;
    busy = true;
    clearError();
    $('progress').textContent = progress;
    dialog.setAttribute('aria-busy', 'true');
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button'))
      button.disabled = true;
    try {
      await work();
    } catch (e) {
      await refresh().catch(() => {});
      if (screen === 'charms') go('charms', false);
      error(e);
    } finally {
      busy = false;
      $('progress').textContent = '';
      dialog.removeAttribute('aria-busy');
      for (const button of dialog.querySelectorAll<HTMLButtonElement>('button'))
        button.disabled = false;
      $<HTMLButtonElement>('connect-charms').disabled = !state.charms.available;
    }
  }
  async function helper(path: string, data?: unknown) {
    if (!state.chatgpt.apiBase) throw new Error('ChatGPT sign-in is not configured.');
    const response = await fetch(new URL(path, state.chatgpt.apiBase), {
      method: data === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Kinetik-Request': '1' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message ?? 'Could not reach the sign-in helper. Try again.');
    }
    return response.json();
  }
  $('later').onclick = close;
  $('start').onclick = close;
  dialog.addEventListener('cancel', () => {
    sessionStorage.removeItem('kinetik-setup');
  });
  $('back').onclick = () => go('charms');
  $('connect-charms').onclick = () =>
    void run(async () => {
      if (state.charms.status === 'connected') {
        go(state.chatgpt.connected ? 'ready' : 'chatgpt');
        return;
      }
      if (state.charms.status === 'disabled') {
        await rpc('connectionActivate');
        await refresh();
        next();
        return;
      }
      sessionStorage.setItem('kinetik-setup', 'charms');
      const destination = await rpc<string>('connectionBegin');
      location.assign(destination);
    }, 'Preparing your Charms connection…');
  $('login').onclick = () => {
    if (busy) return;
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    void run(async () => {
      try {
        const value = await helper('login', {});
        const destination = new URL(value.url);
        if (destination.origin !== 'https://auth.openai.com')
          throw new Error('Unrecognized ChatGPT sign-in address.');
        $<HTMLAnchorElement>('authorize').href = destination.href;
        signingIn = true;
        $('callback').hidden = false;
        $('login').innerHTML = 'Restart sign-in ' + icon('external');
        $('login').classList.replace('primary', 'secondary');
        if (tab) tab.location.replace(destination.href);
        else $('progress').textContent = 'Use “Open sign-in page again” to continue.';
      } catch (e) {
        tab?.close();
        throw e;
      }
    }, 'Opening ChatGPT…');
  };
  $('callback-form').onsubmit = (event) => {
    event.preventDefault();
    if (busy || !signingIn) return;
    const value = $<HTMLInputElement>('return-link').value.trim();
    try {
      const address = new URL(value);
      if (
        address.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(address.hostname) ||
        address.port !== '1455' ||
        address.pathname !== '/auth/callback' ||
        !address.searchParams.get('code') ||
        !address.searchParams.get('state')
      )
        throw new Error();
    } catch {
      error(
        new Error(
          'Copy the entire address from the final localhost page, including everything after “?”.',
        ),
      );
      $('return-link').setAttribute('aria-invalid', 'true');
      $('return-link').focus();
      return;
    }
    void run(async () => {
      await helper('callback', { url: value });
      $<HTMLInputElement>('return-link').value = '';
      $('authorize').removeAttribute('href');
      signingIn = false;
      await refresh();
      next();
    }, 'Connecting your ChatGPT account…');
  };
  $('return-link').oninput = clearError;
  $('retry').onclick = () =>
    void run(async () => {
      await refresh();
      next();
      $('retry').hidden = true;
    }, 'Checking your connections…');
  return {
    open,
    refresh,
    async disconnectCharms() {
      await rpc('connectionDisconnect');
      await refresh();
    },
    async disconnectChatGPT() {
      await helper('logout', {});
      signingIn = false;
      $<HTMLInputElement>('return-link').value = '';
      $('authorize').removeAttribute('href');
      await refresh();
    },
    async initialize() {
      try {
        await refresh();
        if (requested === 'charms' && state.charms.available) {
          await rpc('connectionPrepare');
          await refresh();
        }
        if (
          callback ||
          sessionStorage.getItem('kinetik-setup') ||
          (requested && !(state.charms.status === 'connected' && state.chatgpt.connected))
        )
          open();
        if (requested && requested !== 'charms')
          error(new Error('That connection is not available. No plugin was installed.'));
        if (callback)
          await run(async () => {
            await rpc('connectionFinish', callback);
            await refresh();
            next();
          }, 'Connecting Charms and loading your skills…');
      } catch (e) {
        open();
        error(e);
        $('retry').hidden = false;
      }
    },
  };
}
