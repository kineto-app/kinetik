import { waitForNativeBridge } from './platform/ready';

declare const __NATIVE_BUILD__: boolean;

async function start() {
  // Load the application only after native detection and IPC can succeed.
  if (__NATIVE_BUILD__) await waitForNativeBridge();
  await import('./main');
}

void start().catch((error: unknown) => {
  console.error(error);
  const root = document.getElementById('app');
  if (root) {
    root.setAttribute('role', 'alert');
    root.textContent = 'Kinetik could not start. Close and reopen the app.';
  }
});
