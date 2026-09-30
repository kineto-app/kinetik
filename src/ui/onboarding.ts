import { setupInstallation } from '../browser/installation';
import { rpc } from '../browser/client';
import type { SetupState } from '../connections/manager';
import { icon } from './icons';
import './onboarding.css';

const initial: SetupState = {
  installation: { required: false },
  charms: { available: false, status: 'not-connected' },
  chatgpt: { available: false, connected: false },
};

export function setupConnections(changed: (state: SetupState) => void) {
  let state = initial;
  let busy = false;
  let screen: 'install' | 'handoff' | 'charms' | 'chatgpt' | 'ready' = 'charms';
  const installation = setupInstallation(() => {
    if (screen === 'install' && dialog.open) {
      if (installation.standalone) void initialize();
      else go('install', false);
    }
  });
  let signingIn = false;
  const url = new URL(location.href);
  const callbackAddress = url.href;
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
        <ol class="setup-steps" aria-label="Connection progress"><li data-step="install"><span>1</span>Install</li><li data-step="chatgpt"><span>2</span>ChatGPT</li><li data-step="charms"><span>3</span>Charms</li><li data-step="ready"><span>4</span>Ready</li></ol>
        <h1 id="setup-title" tabindex="-1">Connect Charms</h1>
        <p id="setup-description" class="setup-lead"></p>
        <div id="setup-install" hidden>
          <button id="setup-install-button" class="primary setup-primary">${icon('download')} Install Kinetik</button>
          <ol id="setup-install-instructions" class="setup-instructions"></ol>
          <p id="setup-install-hint" class="setup-hint"></p>
          <details class="setup-install-help"><summary>Need help?</summary><p>Already installed? Open Kinetik from your Home Screen, Dock, or apps.</p><p>Cannot install? Try Safari on iPhone or Mac, or Chrome on desktop or Android.</p></details>
        </div>
        <div id="setup-handoff" hidden><label for="setup-charms-return">Return link for Kinetik</label><textarea id="setup-charms-return" readonly rows="3" spellcheck="false"></textarea><button id="setup-copy-return" class="primary setup-primary">${icon('copy')} Copy return link</button><p class="setup-hint">Keep this link private.</p></div>
        <div id="setup-charms">
          <button id="setup-connect-charms" class="primary setup-primary">Connect Charms ${icon('external')}</button>
          <p id="setup-charms-hint" class="setup-hint">Opens Kineto, then brings you back here.</p>
          <a id="setup-charms-authorize" class="setup-authorize" target="_blank" rel="noopener noreferrer" hidden>Sign in to Kineto ${icon('external')}</a>
          <details id="setup-charms-return-option" class="setup-install-help" hidden><summary>Paste return link</summary><form id="setup-charms-callback"><label for="setup-charms-link">Return link from Kineto</label><p class="setup-hint">Copy the return link after signing in, then paste it here.</p><input id="setup-charms-link" type="text" autocomplete="off" spellcheck="false" placeholder="Paste the return link here"/><button class="primary setup-primary" type="submit">Finish connecting Charms ${icon('check')}</button></form></details>
          <button id="setup-back" class="setup-quiet">Back to ChatGPT</button>
        </div>
        <div id="setup-chatgpt" hidden>
          <div id="setup-helper-missing" class="setup-notice" hidden>ChatGPT sign-in is unavailable here.</div>
          <button id="setup-login" class="primary setup-primary">Continue with ChatGPT ${icon('external')}</button>
          <button id="setup-resume-chatgpt" class="setup-quiet">Paste return link</button>
          <div id="setup-callback" hidden>
            <ol class="setup-instructions"><li><div><strong>Sign in to ChatGPT.</strong><a id="setup-authorize" target="_blank" rel="noopener noreferrer">Reopen sign-in ${icon('external')}</a></div></li>
            <li><div><strong>Copy the full address after sign-in.</strong><p>The final page may not load. Copy its full address anyway.</p><div class="setup-address">127.0.0.1:1455/auth/callback?code=…</div></div></li>
            <li><div><strong>Paste it below.</strong></div></li></ol>
            <form id="setup-callback-form"><label for="setup-return-link">Return link from your browser</label><input id="setup-return-link" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:1455/auth/callback?…" aria-describedby="setup-error"/><button id="setup-finish" class="primary setup-primary" type="submit">Connect ChatGPT ${icon('check')}</button></form>
          </div>

        </div>
        <div id="setup-ready" hidden><div class="setup-ready-list"><p id="setup-charms-ready">${icon('check')}<span>Charms</span><strong>Connected</strong></p><p>${icon('check')}<span>ChatGPT</span><strong>Connected</strong></p></div><button id="setup-start" class="primary setup-primary">Start chatting ${icon('chevron')}</button></div>
        <p id="setup-progress" class="setup-hint" role="status"></p>
        <p id="setup-error" class="setup-error" role="alert" hidden></p>
        <button id="setup-retry" class="secondary" hidden>Try again</button>
      </section>
      <aside id="setup-install-example" class="setup-example setup-install-example" hidden><img class="setup-app-icon" src="./icon.svg" width="90" height="90" alt=""/><div class="setup-app-preview"><div class="brand"><img src="./icon.svg" width="24" height="24" alt=""/>Kinetik</div><strong>What can we get done today?</strong><p>Help me plan a relaxed weekend…</p></div></aside>
      <aside id="setup-chat-example" class="setup-example" aria-label="Example conversation"><div class="setup-example-user">Help me plan a relaxed weekend in Amsterdam.</div><div class="setup-example-reply"><div class="brand"><img src="./icon.svg" width="28" height="28" alt=""/>Kinetik</div><p>Here’s your weekend plan.</p><div class="setup-example-file">${icon('file')}<div><strong>Amsterdam weekend</strong><small>Your itinerary · ready to open</small></div></div></div><p class="setup-hint">Example</p></aside>
    </div>`;
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
    for (const name of ['install', 'handoff', 'charms', 'chatgpt', 'ready'])
      $(name).hidden = name !== next;
    let stepNumber = 0;
    for (const li of dialog.querySelectorAll<HTMLElement>('[data-step]')) {
      li.hidden = li.dataset.step === 'install' && !state.installation.required;
      if (!li.hidden) li.querySelector('span')!.textContent = String(++stepNumber);
      if (li.dataset.step === next) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    }
    $('title').textContent = {
      install: 'Install Kinetik',
      handoff: 'Return to Kinetik',
      charms: 'Connect Charms',
      chatgpt: 'Connect ChatGPT',
      ready: "You're ready",
    }[next];
    $('description').textContent = {
      install: 'Install the app, then open it to sign in.',
      handoff: 'Copy this link and paste it in the Kinetik app.',
      charms: 'Use your Charms files, tools, and skills.',
      chatgpt: 'Chat using your ChatGPT subscription.',
      ready: '',
    }[next];
    $('description').hidden = !$('description').textContent;
    $('later').hidden = blocked() || next === 'handoff';
    $('install-example').hidden = next !== 'install';
    $('chat-example').hidden = next === 'install' || next === 'handoff';
    if (next === 'install') renderInstallation();
    if (next === 'handoff') $<HTMLTextAreaElement>('charms-return').value = callbackAddress;
    $('charms-ready').hidden = state.charms.status !== 'connected';
    $('back').hidden = !state.chatgpt.available;
    $('helper-missing').textContent = 'ChatGPT sign-in is unavailable here.';
    $('helper-missing').hidden = state.chatgpt.available;
    $('login').hidden = !state.chatgpt.available || state.chatgpt.connected;
    $('callback').hidden = !signingIn;
    $('resume-chatgpt').hidden = signingIn || !state.chatgpt.available || state.chatgpt.connected;
    $('authorize').hidden = !$('authorize').hasAttribute('href');
    $('charms-return-option').hidden = !installation.standalone;
    $('connect-charms').innerHTML =
      (state.charms.status === 'connected'
        ? 'Continue'
        : state.charms.status === 'disabled'
          ? 'Enable Charms'
          : state.charms.status === 'reconnect'
            ? 'Reconnect Charms'
            : 'Connect Charms') + icon('external');
    $('charms-hint').textContent = state.charms.available
      ? 'Sign in with Kineto.'
      : 'Charms is not configured on this host.';
    $<HTMLButtonElement>('connect-charms').disabled = !state.charms.available;
    if (focus && dialog.open) {
      $('title').focus();
      dialog.scrollTop = 0;
    }
  }
  function blocked() {
    return state.installation.required && !installation.standalone;
  }
  function renderInstallation() {
    $('install-button').hidden = !installation.available || installation.accepted;
    const steps = installation.accepted
      ? [['Open Kinetik from your apps.', '']]
      : installation.platform === 'ios'
        ? [
            ['In Safari, open Share.', 'Look beside the address bar or under More.'],
            ['Choose Add to Home Screen.', 'Keep “Open as Web App” on, then tap Add.'],
            ['Open Kinetik from your Home Screen.', ''],
          ]
        : installation.platform === 'mac-safari'
          ? [
              ['Open Safari’s File or Share menu.', 'Choose Add to Dock, then Add.'],
              ['Open Kinetik from your Dock.', ''],
            ]
          : installation.available
            ? []
            : installation.platform === 'chromium'
              ? [
                  [
                    'Open your browser’s menu.',
                    'Choose Install app, sometimes under Cast, save, and share.',
                  ],
                  ['Install, then open Kinetik.', ''],
                ]
              : [
                  [
                    'Open this page in a browser that installs apps.',
                    'Use Safari on iPhone or Mac, Chrome or Edge on desktop, or Chrome on Android.',
                  ],
                  ['Install and open Kinetik.', ''],
                ];
    $('install-instructions').innerHTML = steps
      .map(
        ([title, text]) =>
          `<li><div><strong>${title}</strong>${text ? `<p>${text}</p>` : ''}</div></li>`,
      )
      .join('');
    $('install-instructions').hidden = !steps.length;
    $('install-hint').textContent =
      installation.available && !installation.accepted
        ? 'Confirm in your browser, then open Kinetik.'
        : '';
  }
  function next() {
    go(
      blocked()
        ? 'install'
        : !state.chatgpt.connected && state.chatgpt.available
          ? 'chatgpt'
          : state.charms.available && state.charms.status !== 'connected'
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
    if (blocked() || screen === 'handoff') return;
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
  dialog.addEventListener('cancel', (event) => {
    if (blocked() || screen === 'handoff') {
      event.preventDefault();
      return;
    }
    sessionStorage.removeItem('kinetik-setup');
  });
  $('back').onclick = () => go('chatgpt');
  $('install-button').onclick = () =>
    void run(() => installation.prompt(), 'Waiting for your browser…');
  $('copy-return').onclick = () =>
    void run(async () => {
      await navigator.clipboard.writeText(callbackAddress);
      $('copy-return').textContent = 'Copied. Open Kinetik to finish.';
    }, 'Copying return link…');
  $('connect-charms').onclick = () => {
    if (busy) return;
    const tab =
      installation.standalone && !['connected', 'disabled'].includes(state.charms.status)
        ? window.open('about:blank', '_blank')
        : null;
    if (tab) tab.opener = null;
    void run(async () => {
      try {
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
        const destination = await rpc<string>('connectionBegin', {
          handoff: installation.standalone,
        });
        if (installation.standalone) {
          $<HTMLAnchorElement>('charms-authorize').href = destination;
          $<HTMLDetailsElement>('charms-return-option').open = true;
          $('charms-authorize').hidden = false;
          if (tab) tab.location.replace(destination);
        } else location.assign(destination);
      } catch (e) {
        tab?.close();
        throw e;
      }
    }, 'Preparing your Charms connection…');
  };
  $('resume-chatgpt').onclick = () => {
    signingIn = true;
    go('chatgpt');
    $('return-link').focus();
  };
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
        $('resume-chatgpt').hidden = true;
        $('authorize').hidden = false;
        $('callback').hidden = false;
        $('login').innerHTML = 'Restart sign-in ' + icon('external');
        $('login').classList.replace('primary', 'secondary');
        if (tab) tab.location.replace(destination.href);
        else $('progress').textContent = 'Use “Reopen sign-in” to continue.';
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
  $('charms-callback').onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      const address = new URL($<HTMLInputElement>('charms-link').value.trim());
      if (
        address.origin !== location.origin ||
        address.pathname !== new URL('./', location.href).pathname ||
        address.searchParams.get('connection_callback') !== 'charms'
      )
        throw new Error('Paste the return link from the Kineto sign-in tab.');
      await rpc('connectionFinish', {
        state: address.searchParams.get('state') ?? '',
        code: address.searchParams.get('code') ?? '',
        error: address.searchParams.get('error') ?? '',
        issuer: address.searchParams.get('iss') ?? '',
      });
      $<HTMLInputElement>('charms-link').value = '';
      $('charms-authorize').removeAttribute('href');
      $('charms-authorize').hidden = true;
      $<HTMLDetailsElement>('charms-return-option').open = false;
      await refresh();
      next();
    }, 'Connecting Charms and loading your skills…');
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
    initialize,
  };
  async function initialize() {
    try {
      await refresh();
      if (callback?.state.startsWith('app.') && !installation.standalone) {
        open();
        go('handoff');
        return;
      }
      if (blocked()) {
        open();
        if (callback) go('handoff');
        return;
      }
      if ((requested === 'charms' || state.installation.required) && state.charms.available) {
        await rpc('connectionPrepare');
        await refresh();
      }
      if (
        (state.installation.required &&
          !(state.charms.status === 'connected' && state.chatgpt.connected)) ||
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
  }
}
