/** Native initialization can finish after the page's module scripts start in WebView2. */
export async function waitForNativeBridge(timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const bridge = (
      window as Window & {
        __TAURI_INTERNALS__?: {
          invoke?: unknown;
          transformCallback?: unknown;
          metadata?: { currentWindow?: { label?: unknown } };
        };
      }
    ).__TAURI_INTERNALS__;
    if (
      typeof bridge?.invoke === 'function' &&
      typeof bridge.transformCallback === 'function' &&
      typeof bridge.metadata?.currentWindow?.label === 'string'
    )
      return;
    if (Date.now() >= deadline) throw new Error('Native bridge did not initialize.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
