// CI-only diagnostics for the fresh, signed-out Windows application.
// Use the page CDP endpoint directly: browser-level auto-attach can stall in WebView2.
import { writeFile } from 'node:fs/promises';
const response = await fetch('http://127.0.0.1:9222/json/list', {
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`WebView discovery failed: ${response.status}`);
const targets = await response.json();
const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
if (!target) throw new Error('No WebView page was exposed for diagnostics.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebView connection timed out.')), 10000);
  socket.addEventListener(
    'open',
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  socket.addEventListener(
    'error',
    (event) => {
      clearTimeout(timer);
      reject(event.error ?? new Error('WebView connection failed.'));
    },
    { once: true },
  );
});
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const result = await call('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href,
      nativeBridge: typeof window.__TAURI_INTERNALS__,
      nativeInvoke: typeof window.__TAURI_INTERNALS__?.invoke,
      worker: navigator.serviceWorker?.controller?.scriptURL,
      ready: document.readyState,
      errors: [...document.querySelectorAll('[id$="error"]')].map(el => el.textContent)
    })`,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  await writeFile('windows-webview.json', JSON.stringify(JSON.parse(result.result.value), null, 2));
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile('windows-webview.png', Buffer.from(screenshot.data, 'base64'));
} finally {
  socket.close();
}
