import { capabilities, isNative } from '../platform/environment';
import { setupInstallation } from '../browser/installation';
import { rpc } from '../browser/client';
import type { SetupState } from '../connections/manager';
import type { CustomModelState } from '../connections/custom-model';
import { icon } from './icons';
import './onboarding.css';

const initial: SetupState = {
  platform: 'unknown',
  capabilities: capabilities('unknown'),
  app: {},
  installation: { required: false },
  charms: { available: false, status: 'not-connected' },
  chatgpt: { available: false, connected: false },
};

const laterKey = 'kinetik-setup-later';
const laterChosen = () => {
  try {
    return localStorage.getItem(laterKey) === '1';
  } catch {
    return false;
  }
};

export function setupConnections(changed: (state: SetupState) => void) {
  let state = initial;
  let busy = false;
  let screen: 'install' | 'handoff' | 'connected' | 'charms' | 'chatgpt' | 'ready' | 'consent' =
    'charms';
  /** Settles the open consent question: agreed, or closed without agreeing. */
  let answerConsent: ((agreed: boolean) => void) | undefined;
  const installation = setupInstallation(() => {
    renderInstallButtons();
    if (screen === 'install' && dialog.open) go('install', false);
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
    <header class="setup-nav"><div class="brand"><img src="./icon.svg" width="34" height="34" alt=""/>Kinetik</div><div class="actions"><button id="setup-install-open" class="setup-quiet">Install</button><button id="setup-later" class="setup-quiet" aria-label="Set up later">Later</button></div></header>
    <div class="setup-body">
      <section class="setup-main">
        <ol class="setup-steps" aria-label="Connection progress"><li data-step="chatgpt"><span>2</span>ChatGPT</li><li data-step="charms"><span>3</span>Charms</li><li data-step="ready"><span>4</span>Ready</li></ol>
        <h1 id="setup-title" tabindex="-1">Connect Charms</h1>
        <p id="setup-description" class="setup-lead"></p>
        <div id="setup-install" hidden>
          <button id="setup-install-button" class="primary setup-primary">${icon('download')} Install Kinetik</button>
          <ol id="setup-install-instructions" class="setup-instructions"></ol>
          <p id="setup-install-hint" class="setup-hint"></p><button id="setup-install-continue" class="secondary setup-primary">Continue in browser</button>
          <details class="setup-install-help"><summary>Need help?</summary><p>Already installed? Open Kinetik from your Home Screen, Dock, or apps.</p><p>Cannot install? Try Safari on iPhone or Mac, or Chrome on desktop or Android.</p></details>
        </div>
        <div id="setup-connected" hidden><button id="setup-return-to-app" class="primary setup-primary">Return to Kinetik</button></div><div id="setup-handoff" hidden><label for="setup-charms-return">Return link for Kinetik</label><textarea id="setup-charms-return" readonly rows="3" spellcheck="false"></textarea><button id="setup-copy-return" class="primary setup-primary">${icon('copy')} Copy return link</button><p class="setup-hint">Keep this link private.</p></div>
        <div id="setup-charms">
          <p id="setup-charms-consent" class="setup-consent"><span></span> <a class="setup-privacy" target="_blank" rel="noopener noreferrer" hidden>Privacy</a></p>
          <button id="setup-connect-charms" class="primary setup-primary">Connect Charms ${icon('external')}</button>
          <p id="setup-charms-hint" class="setup-hint">Opens Kineto, then brings you back here.</p>
          <a id="setup-charms-authorize" class="setup-authorize" target="_blank" rel="noopener noreferrer" hidden>Sign in to Kineto ${icon('external')}</a>
          <details id="setup-charms-return-option" class="setup-install-help" hidden><summary>Paste return link</summary><form id="setup-charms-callback"><label for="setup-charms-link">Return link from Kineto</label><p class="setup-hint">Copy the return link after signing in, then paste it here.</p><input id="setup-charms-link" type="text" autocomplete="off" spellcheck="false" placeholder="Paste the return link here"/><button class="primary setup-primary" type="submit">Finish connecting Charms ${icon('check')}</button></form></details>
          <button id="setup-back" class="setup-quiet">Back to ChatGPT</button>
        </div>
        <div id="setup-chatgpt" hidden>
          <div id="setup-helper-missing" class="setup-notice" hidden>ChatGPT sign-in is unavailable here.</div>
          <p id="setup-chatgpt-consent" class="setup-consent"><span></span> <a class="setup-privacy" target="_blank" rel="noopener noreferrer" hidden>Privacy</a></p>
          <button id="setup-login" class="primary setup-primary">Agree and continue ${icon('external')}</button>
          <button id="setup-resume-chatgpt" class="setup-quiet">Paste return link</button>
          <div id="setup-callback" hidden>
            <ol class="setup-instructions"><li><div><strong>Sign in to ChatGPT.</strong><a id="setup-authorize" target="_blank" rel="noopener noreferrer">Reopen sign-in ${icon('external')}</a></div></li>
            <li><div><strong>Copy the full address after sign-in.</strong><p>The final page may not load. Copy its full address anyway.</p><div class="setup-address">127.0.0.1:1455/auth/callback?code=…</div></div></li>
            <li><div><strong>Paste it below.</strong></div></li></ol>
            <form id="setup-callback-form"><label for="setup-return-link">Return link from your browser</label><input id="setup-return-link" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:1455/auth/callback?…" aria-describedby="setup-error"/><button id="setup-finish" class="primary setup-primary" type="submit">Connect ChatGPT ${icon('check')}</button></form>
          </div>

        </div>
        <div id="setup-consent" hidden><p id="setup-served-consent" class="setup-consent"><span></span> <a class="setup-privacy" target="_blank" rel="noopener noreferrer" hidden>Privacy</a></p><button id="setup-agree" class="primary setup-primary">Agree and continue ${icon('chevron')}</button><button id="setup-not-now" class="setup-quiet">Not now</button></div>
        <div id="setup-ready" hidden><div class="setup-ready-list"><p id="setup-charms-ready">${icon('check')}<span>Charms</span><strong>Connected</strong></p><p>${icon('check')}<span>ChatGPT</span><strong>Connected</strong></p></div><button id="setup-start" class="primary setup-primary">Start chatting ${icon('chevron')}</button></div>
        <p id="setup-progress" class="setup-hint" role="status"></p><button id="setup-cancel-signin" class="setup-quiet" hidden>Cancel sign-in</button>
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
    for (const name of ['install', 'handoff', 'connected', 'charms', 'chatgpt', 'ready', 'consent'])
      $(name).hidden = name !== next;
    dialog.querySelector<HTMLElement>('.setup-steps')!.hidden = [
      'install',
      'handoff',
      'connected',
      'consent',
    ].includes(next);
    let stepNumber = 0;
    for (const li of dialog.querySelectorAll<HTMLElement>('[data-step]')) {
      if (!li.hidden) li.querySelector('span')!.textContent = String(++stepNumber);
      if (li.dataset.step === next) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    }
    $('title').textContent = {
      install: 'Install Kinetik',
      handoff: 'Return to Kinetik',
      connected: 'Charms connected',
      charms: 'Connect Charms',
      chatgpt: 'Connect ChatGPT',
      ready: "You're ready",
      consent: `Before you chat with ${state.models?.name ?? 'this model'}`,
    }[next];
    $('description').textContent = {
      install: 'Add Kinetik to your Home Screen or Dock.',
      connected: 'Return to Kinetik to continue.',
      handoff: 'Copy this link and paste it in the Kinetik app.',
      charms: 'Use your Charms files, tools, and skills.',
      chatgpt: 'Chat using your ChatGPT subscription.',
      ready: '',
      consent: '',
    }[next];
    $('description').hidden = !$('description').textContent;
    $('later').hidden = ['handoff', 'connected', 'consent'].includes(next);
    renderInstallButtons();
    $('install-example').hidden = next !== 'install';
    $('chat-example').hidden = ['install', 'handoff', 'connected'].includes(next);
    if (next === 'install') renderInstallation();
    if (next === 'handoff') $<HTMLTextAreaElement>('charms-return').value = callbackAddress;
    $('charms-ready').hidden = state.charms.status !== 'connected';
    $('back').hidden = !state.chatgpt.available;
    $('helper-missing').textContent = 'ChatGPT sign-in is unavailable here.';
    $('helper-missing').hidden = state.chatgpt.available;
    $('login').hidden = !state.chatgpt.available || state.chatgpt.connected;
    // Consent lines come from configuration, so they are set as text, never as markup.
    consent(
      'chatgpt',
      state.chatgpt.relay
        ? `Your messages and files go to OpenAI through ${owner()} servers to get replies.`
        : 'Your messages and files go to OpenAI to get replies.',
      !state.chatgpt.available || state.chatgpt.connected,
    );
    consent(
      'charms',
      (state.models?.offered
        ? `Your messages and files go to ${owner()} servers and its AI provider to get replies. `
        : '') + `Skills run on ${owner()} servers with the files you share.`,
      !state.charms.available,
    );
    consent(
      'served',
      `Your messages and files go to ${owner()} servers and its AI provider to get replies.`,
      false,
    );
    $('callback').hidden = !signingIn;
    $('resume-chatgpt').hidden =
      isNative || signingIn || !state.chatgpt.available || state.chatgpt.connected;
    $('authorize').hidden = !$('authorize').hasAttribute('href');
    const charmsAuthorized = ['connected', 'disabled'].includes(state.charms.status);
    $('charms-return-option').hidden = isNative || !installation.standalone || charmsAuthorized;
    if (charmsAuthorized) {
      // The OAuth code has already been consumed. Retry activation using the saved credential.
      $<HTMLInputElement>('charms-link').value = '';
      $('charms-authorize').removeAttribute('href');
      $('charms-authorize').hidden = true;
      $<HTMLDetailsElement>('charms-return-option').open = false;
    }
    $('connect-charms').innerHTML =
      (state.charms.status === 'connected'
        ? 'Continue'
        : state.charms.status === 'disabled'
          ? 'Enable Charms'
          : state.charms.status === 'reconnect'
            ? 'Reconnect Charms'
            : 'Connect Charms') + icon(charmsAuthorized ? 'chevron' : 'external');
    $('charms-hint').textContent = state.charms.available
      ? charmsAuthorized
        ? 'Signed in to Kineto.'
        : 'Sign in with Kineto.'
      : 'Charms is not configured on this host.';
    $<HTMLButtonElement>('connect-charms').disabled = !state.charms.available;
    if (focus && dialog.open) {
      $('title').focus();
      dialog.scrollTop = 0;
    }
  }
  /** Whose servers: the configured service's name, or a neutral fallback. */
  const owner = () => (state.app.serviceName ? `${state.app.serviceName}'s` : "the service's");
  function consent(step: 'chatgpt' | 'charms' | 'served', text: string, hidden: boolean) {
    const line = $(`${step}-consent`);
    line.hidden = hidden;
    line.querySelector('span')!.textContent = text;
    const privacy = line.querySelector<HTMLAnchorElement>('a')!;
    if (state.app.privacyUrl) privacy.href = state.app.privacyUrl;
    else privacy.removeAttribute('href');
    privacy.hidden = !state.app.privacyUrl;
  }
  function renderInstallButtons() {
    const hidden = isNative || installation.standalone;
    $('install-open').hidden =
      hidden || screen === 'install' || screen === 'handoff' || screen === 'connected';
    const button = document.getElementById('install-open');
    if (button) button.hidden = hidden;
  }
  function install() {
    go('install');
    if (!dialog.open) dialog.showModal();
    $('title').focus();
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
      !state.chatgpt.connected && state.chatgpt.available
        ? 'chatgpt'
        : state.charms.available && state.charms.status !== 'connected'
          ? 'charms'
          : state.chatgpt.connected
            ? 'ready'
            : 'chatgpt',
    );
  }
  /** Opens on the next missing step, or on `step` when a turn waits for that sign-in. */
  function open(step?: 'charms') {
    if (step) go(step);
    else next();
    if (!dialog.open) dialog.showModal();
    $('title').focus();
  }
  function close() {
    if (screen === 'handoff' || screen === 'connected') return;
    dialog.close();
    sessionStorage.removeItem('kinetik-setup');
    document.getElementById('prompt')?.focus();
  }
  async function refresh() {
    const previous = state;
    state = await rpc<SetupState>('setupState');
    changed(state);
    renderInstallButtons();
    if (
      !busy &&
      dialog.open &&
      screen === 'charms' &&
      previous.charms.status !== state.charms.status
    )
      next();
  }
  async function run(work: () => Promise<void>, progress: string) {
    if (busy) return;
    busy = true;
    clearError();
    $('progress').textContent = progress;
    dialog.setAttribute('aria-busy', 'true');
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button'))
      button.disabled = true;
    if (isNative) {
      $('cancel-signin').hidden = false;
      $<HTMLButtonElement>('cancel-signin').disabled = false;
    }
    try {
      await work();
    } catch (e) {
      await refresh().catch(() => {});
      if (screen === 'charms') go('charms', false);
      error(e);
    } finally {
      busy = false;
      $('cancel-signin').hidden = true;
      $('progress').textContent = '';
      dialog.removeAttribute('aria-busy');
      for (const button of dialog.querySelectorAll<HTMLButtonElement>('button'))
        button.disabled = false;
      $<HTMLButtonElement>('connect-charms').disabled = !state.charms.available;
    }
  }
  async function helper(path: string, data?: unknown) {
    if (state.chatgpt.browser) {
      const result = await rpc<{ url: string }>('chatgpt', {
        action: path,
        ...((data as Record<string, unknown>) ?? {}),
      });
      if (path === 'callback') void navigator.storage?.persist?.().catch(() => false);
      return result;
    }
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
  $('cancel-signin').onclick = () =>
    void import('../platform/native').then((native) => native.cancelNativeAuthentication());
  $('later').onclick = () => {
    try {
      localStorage.setItem(laterKey, '1');
    } catch {
      /* Without storage it simply asks again next time. */
    }
    close();
  };
  $('start').onclick = close;
  $('agree').onclick = () =>
    void run(async () => {
      await rpc('models', { action: 'consent' });
      await refresh().catch(() => {});
      answerConsent?.(true);
      answerConsent = undefined;
      close();
    }, 'Saving…');
  // Declining sends nothing; touch devices have no Escape key to close with.
  $('not-now').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    answerConsent?.(false);
    answerConsent = undefined;
  });
  dialog.addEventListener('cancel', (event) => {
    if (screen === 'handoff' || screen === 'connected') {
      event.preventDefault();
      return;
    }
    sessionStorage.removeItem('kinetik-setup');
  });
  $('install-open').onclick = install;
  $('install-continue').onclick = () => {
    if (state.chatgpt.available || state.charms.available) next();
    else close();
  };
  $('return-to-app').onclick = () => location.replace(new URL('./', location.href).href);
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
    // The step showed where messages to the served model go; continuing agrees to it.
    if (state.models?.offered) void rpc('models', { action: 'consent' }).catch(() => {});
    const tab =
      !isNative && !['connected', 'disabled'].includes(state.charms.status)
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
        if (isNative) {
          await (await import('../platform/native')).authenticateNative('charms');
          await refresh();
          next();
          return;
        }
        sessionStorage.setItem('kinetik-setup', 'charms');
        const destination = await rpc<string>('connectionBegin', {
          handoff: true,
        });
        $<HTMLAnchorElement>('charms-authorize').href = destination;
        $('charms-hint').textContent = 'Finish signing in, then return here.';
        $('charms-authorize').hidden = false;
        if (tab) tab.location.replace(destination);
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
    const tab = isNative ? null : window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    void run(async () => {
      try {
        if (isNative) {
          await (await import('../platform/native')).authenticateNative('chatgpt');
          await refresh();
          next();
          return;
        }
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
    install,
    refresh,
    /** Shows once where messages to the model Charms serves go; true once the user agrees. */
    askConsent() {
      answerConsent?.(false);
      return new Promise<boolean>((resolve) => {
        answerConsent = resolve;
        go('consent');
        if (!dialog.open) dialog.showModal();
        $('title').focus();
      });
    },
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
      // Separate browser/PWA storage may not contain the initiating PKCE request.
      // Only that case needs a manual handoff; finish() still validates the full request.
      if (
        callback?.state.startsWith('app.') &&
        !(await rpc<boolean>('connectionCanFinish', { state: callback.state }))
      ) {
        open();
        go('handoff');
        return;
      }
      if ((requested === 'charms' || state.installation.required) && state.charms.available) {
        await rpc('connectionPrepare');
        await refresh();
      }
      // Someone who already chats through a custom model, or chose "Later", is not sent back here.
      const settled =
        laterChosen() ||
        (await rpc<CustomModelState>('customModel', { action: 'state' })).configured;
      // A build without Charms has nothing to connect there, so ChatGPT alone completes setup.
      const ready =
        (!state.charms.available || state.charms.status === 'connected') && state.chatgpt.connected;
      if (
        (state.installation.required && !settled && !ready) ||
        callback ||
        sessionStorage.getItem('kinetik-setup') ||
        (requested && !ready)
      )
        open();
      if (requested && requested !== 'charms')
        error(new Error('That connection is not available. No plugin was installed.'));
      if (callback)
        await run(async () => {
          await rpc('connectionFinish', callback);
          await refresh();
          if (callback.state.startsWith('app.')) {
            go('connected');
            window.close();
          } else next();
        }, 'Connecting Charms and loading your skills…');
    } catch (e) {
      open();
      error(e);
      $('retry').hidden = false;
    }
  }
}
