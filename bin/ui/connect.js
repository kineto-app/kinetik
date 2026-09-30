const $ = (id) => document.getElementById(id);
const apiBase = document.body.dataset.apiBase;
let invitation = location.hash.slice(1);
let signInStarted = false;
let busy = false;

async function api(path, data) {
  let response;
  try {
    response = await fetch(apiBase + path, {
      method: data ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Kinetik-Request': '1' },
      body: data ? JSON.stringify(data) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new Error(
      'We could not reach the connection helper. Check your connection and try again.',
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new Error(
      'This preview invitation has expired. Open your latest private invitation link to try again.',
    );
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(
      value.error?.message || 'The connection helper is unavailable. Try again in a moment.',
    );
  }
  return response.json();
}
function step(number) {
  ['step-signin', 'step-copy', 'step-paste'].forEach((id, index) => {
    if (index === number - 1) $(id).setAttribute('aria-current', 'step');
    else $(id).removeAttribute('aria-current');
  });
  $('progress').textContent = `Step ${number} of 3`;
}
function showError(error, field = false) {
  const element = $(field ? 'callback-error' : 'connection-error');
  element.textContent = error.message;
  element.hidden = false;
  if (field) {
    $('callback').setAttribute('aria-invalid', 'true');
    $('callback').focus();
  }
}
function clearError() {
  $('callback-error').hidden = true;
  $('connection-error').hidden = true;
  $('callback').removeAttribute('aria-invalid');
}
async function status() {
  const value = await api('status');
  $('setup').hidden = value.connected;
  $('success').hidden = !value.connected;
  $('status').textContent = value.connected
    ? 'Your ChatGPT plan is connected to this preview.'
    : signInStarted
      ? 'Finish signing in, then copy the final address and paste it below.'
      : 'Three quick steps. No API key needed.';
  if (value.connected) {
    $('progress').textContent = 'Connected';
    $('callback').value = '';
    $('authorize').removeAttribute('href');
    $('authorize').hidden = true;
    signInStarted = false;
  } else step(signInStarted ? 2 : 1);
}
async function start() {
  clearError();
  $('retry').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    if (invitation) {
      await api('claim', { invite: invitation });
      invitation = '';
    }
    await status();
  } catch (error) {
    $('setup').hidden = true;
    $('success').hidden = true;
    $('status').textContent = 'We could not open this connection.';
    $('progress').textContent = 'Connection needed';
    $('retry').hidden = false;
    showError(error);
  }
}
$('login').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  clearError();
  // Open synchronously from the click so browsers do not block the new tab.
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  $('login').disabled = true;
  $('login').textContent = 'Opening ChatGPT…';
  try {
    const value = await api('login', {});
    const destination = new URL(value.url);
    if (destination.origin !== 'https://auth.openai.com')
      throw new Error('The sign-in address was not recognized. Please try again.');
    $('authorize').href = destination.href;
    $('authorize').hidden = false;
    signInStarted = true;
    $('callback').disabled = false;
    $('connect').disabled = false;
    $('status').textContent = popup
      ? 'ChatGPT is open in another tab. Return here with the final address.'
      : 'Your browser blocked the new tab. Use “Open sign-in page again” below.';
    step(2);
    if (popup) popup.location.replace(destination.href);
  } catch (error) {
    popup?.close();
    showError(error);
  } finally {
    $('login').disabled = false;
    $('login').textContent = signInStarted ? 'Restart sign-in ↗' : 'Continue with ChatGPT ↗';
    $('login').classList.toggle('primary', !signInStarted);
    $('login').classList.toggle('secondary', signInStarted);
    busy = false;
  }
});
$('callback').addEventListener('input', () => {
  clearError();
  if (signInStarted) step($('callback').value.trim() ? 3 : 2);
});
$('callback-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !signInStarted) return;
  clearError();
  const value = $('callback').value.trim();
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
    showError(
      new Error(
        'Copy the entire address from the final localhost page, including everything after “?”. A ChatGPT website link will not work here.',
      ),
      true,
    );
    return;
  }
  busy = true;
  $('connect').disabled = true;
  $('login').disabled = true;
  $('connect').textContent = 'Connecting your account…';
  $('callback-form').setAttribute('aria-busy', 'true');
  try {
    await api('callback', { url: value });
    $('callback').value = '';
    await status();
    $('open').focus();
  } catch (error) {
    showError(
      new Error(
        `${error.message} If the link has expired or was already used, restart sign-in above to get a fresh one.`,
      ),
      true,
    );
  } finally {
    busy = false;
    $('connect').disabled = false;
    $('login').disabled = false;
    $('connect').textContent = 'Connect & start chatting →';
    $('callback-form').removeAttribute('aria-busy');
  }
});
$('logout').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('logout').disabled = true;
  clearError();
  try {
    await api('logout', {});
    signInStarted = false;
    $('callback').disabled = true;
    $('connect').disabled = true;
    $('login').textContent = 'Continue with ChatGPT ↗';
    $('login').classList.add('primary');
    $('login').classList.remove('secondary');
    await status();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    $('logout').disabled = false;
  }
});
$('retry').addEventListener('click', start);
window.addEventListener('hashchange', () => {
  if (location.hash) {
    invitation = location.hash.slice(1);
    start();
  }
});
start();
