// CI-only diagnostics for the fresh, signed-out Windows application.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', {
  noDefaults: true,
  timeout: 5000,
});
try {
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  const state = await page.evaluate(() => ({
    url: location.href,
    nativeBridge: typeof window.__TAURI_INTERNALS__,
    nativeInvoke: typeof window.__TAURI_INTERNALS__?.invoke,
    worker: navigator.serviceWorker?.controller?.scriptURL,
    ready: document.readyState,
    errors: [...document.querySelectorAll('[id$="error"]')].map((el) => el.textContent),
  }));
  await writeFile('windows-webview.json', JSON.stringify(state, null, 2));
  await page.screenshot({ path: 'windows-webview.png' });
} finally {
  await browser.close();
}
