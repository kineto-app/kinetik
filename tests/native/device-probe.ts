// Injected into a debug WebView by the device test runner. Never included in application assets.
import { RuntimeHost } from '../../src/core/host';
import { Store } from '../../src/browser/store';
import { NativeStore } from '../../src/platform/secure-store';
import { invoke, addPluginListener } from '@tauri-apps/api/core';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
export { importNativeFile, saveNativeFile } from '../../src/platform/files';

let heartbeat: ReturnType<typeof setInterval>;
const host = new RuntimeHost(
  new Store('kinetik-device-probe-v1'),
  new URL('./', location.href),
  () => {},
  { connections: {} },
);
const call = <T>(op: string, data: Record<string, unknown> = {}): Promise<T> =>
  new Promise((resolve, reject) => {
    void host
      .handle({ op, ...data }, (reply) =>
        reply.ok ? resolve(reply.result as T) : reject(new Error(reply.error)),
      )
      .catch(reject);
  });
export async function start(command: string) {
  await host.initialize();
  await addPluginListener('native', 'background-stop', async () => {
    for (const conversation of await host.runtime.conversations())
      await host.runtime.stop(conversation.id);
    clearInterval(heartbeat);
  });
  const beat = () => invoke('plugin:native|background', { payload: { active: true } });
  await beat();
  heartbeat = setInterval(() => {
    void beat();
    void call('tick');
    void call('resume');
  }, 15000);
  const conversation = await call<{ id: string }>('create');
  await call('submit', { id: conversation.id, text: command });
  return conversation.id;
}
export async function finish() {
  clearInterval(heartbeat);
  await invoke('plugin:native|background', { payload: { active: false } });
}
export const state = () => call('state');
export async function credentials(write = false) {
  const store = new NativeStore('kinetik-device-probe', true);
  if (write)
    await store.put('probe', { value: 'credential-persistence-test', large: 'x'.repeat(16000) });
  const saved = await store.get<{ value: string; large: string }>('probe');
  return saved?.value === 'credential-persistence-test' && saved.large.length === 16000;
}
export async function transport(url: string) {
  const response = await nativeFetch(url, { redirect: 'error', maxRedirections: 0 });
  return { status: response.status, body: await response.json() };
}
export const rpc = call;
