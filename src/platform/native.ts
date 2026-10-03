import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { protocolVersion, type Op } from '../core/protocol';
import { platformFetch } from './native-fetch';
import { RuntimeHost } from '../core/host';
import { BrowserChatGPT } from '../connections/chatgpt';
import { parseConfiguration, type Configuration } from '../connections/config';
import { NativeStore } from './secure-store';

declare const __NATIVE_CONFIG__: unknown;
let host: RuntimeHost;
let ready: Promise<void> | undefined;
let lastActive = false;
let authenticating = false;
let syncing: Promise<void> | undefined;

export function connectNative() {
  return (ready ??= boot().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
async function boot() {
  // Only the trusted application uses native transport. Sandboxed MCP frames do not inherit it.
  globalThis.fetch = platformFetch;
  const base = new URL('./', document.baseURI);
  const config: Configuration = {
    ...parseConfiguration(__NATIVE_CONFIG__ ?? { connections: {} }, base),
    native: true,
    installation: { required: true },
    chatgpt: { mode: 'browser', jwksUrl: 'https://auth.openai.com/.well-known/jwks.json' },
  };
  const chatgpt = new BrowserChatGPT(
    config.chatgpt!.mode === 'browser' ? config.chatgpt!.jwksUrl : '',
    new NativeStore('chatgpt', true),
  );
  host = new RuntimeHost(
    new NativeStore(),
    base,
    (event) => {
      window.dispatchEvent(new CustomEvent('kinetik-changed', { detail: event }));
      // Streamed text and progress change nothing the background service tracks.
      if (!event) void synchronizeBackground();
    },
    config,
    chatgpt,
  );
  host.notify = async ({ conversationId, title, body }) => {
    if (document.visibilityState === 'visible') return;
    // The chat id rides in `url` so a tap on the notification opens that chat.
    await invoke('plugin:native|notify', {
      payload: { key: title, value: body, url: conversationId },
    });
  };
  await host.initialize();
  // Opening the tapped chat is a convenience; the app works without it.
  await addPluginListener('native', 'open-chat', ({ id }: { id: string }) =>
    window.dispatchEvent(new CustomEvent('kinetik-open-chat', { detail: id })),
  ).catch(() => {});
  if (/Android/i.test(navigator.userAgent))
    await addPluginListener('native', 'background-stop', async () => {
      const jobs = await host.store.entries<{ conversationId: string; state: string }>(
        'background:',
      );
      const working = new Set(
        jobs
          .filter(([, job]) => ['running', 'waiting'].includes(job.state))
          .map(([, job]) => job.conversationId),
      );
      for (const conversation of await host.runtime.conversations(() => false))
        if (
          working.has(conversation.id) ||
          ['queued', 'running', 'waiting'].includes(conversation.status)
        )
          await host.runtime.stop(conversation.id);
      if (authenticating) await cancelNativeAuthentication();
      await synchronizeBackground();
    });
  setInterval(() => {
    void nativeRPC('tick').catch(report);
    void nativeRPC('resume').catch(report);
    void synchronizeBackground(true);
  }, 15000);
}
function report(error: unknown) {
  window.dispatchEvent(new CustomEvent('kinetik-native-error', { detail: error }));
}
async function synchronizeBackground(heartbeat = false) {
  if (!host?.runtime) return;
  if (syncing) return syncing;
  syncing = (async () => {
    const conversations = await host.runtime.conversations(() => false);
    const jobs = await host.store.entries<{ state: string }>('background:');
    const active =
      authenticating ||
      conversations.some(
        (c) =>
          ['running', 'queued'].includes(c.status) ||
          (c.status === 'waiting' && c.waitingFor !== 'signin'),
      ) ||
      jobs.some(([, j]) => ['running', 'waiting'].includes(j.state));
    if (active !== lastActive || (heartbeat && active)) {
      await invoke('plugin:native|background', { payload: { active } });
      lastActive = active;
    }
  })()
    .catch(report)
    .finally(() => {
      syncing = undefined;
    });
  return syncing;
}
export async function nativeRPC<T>(op: Op, data: Record<string, unknown> = {}): Promise<T> {
  await connectNative();
  return new Promise<T>((resolve, reject) => {
    void host
      .handle({ op, ...data, protocol: protocolVersion }, (reply) => {
        if (reply.ok) resolve(reply.result as T);
        else reject(new Error(reply.error));
      })
      .catch(reject);
  });
}
export async function cancelNativeAuthentication() {
  await invoke('auth_cancel');
}
export async function authenticateNative(provider: 'chatgpt' | 'charms') {
  await connectNative();
  authenticating = true;
  await synchronizeBackground();
  try {
    const prepared = await invoke<{ id: string; redirectUri: string }>('auth_prepare', {
      path: provider === 'chatgpt' ? '/auth/callback' : '/charms/callback',
    });
    const result =
      provider === 'chatgpt'
        ? await nativeRPC<{ url: string }>('chatgpt', {
            action: 'login',
            redirectUri: prepared.redirectUri,
          })
        : {
            url: await nativeRPC<string>('connectionBegin', { redirectUri: prepared.redirectUri }),
          };
    const url = new URL(result.url);
    const expectedState = url.searchParams.get('state');
    if (!expectedState) throw new Error('Sign-in did not provide a state.');
    // The listener is already bound before the browser opens. Register the wait first.
    const completion = invoke<string>('auth_wait', { id: prepared.id, expectedState });
    void completion.catch(() => {});
    const [callback] = await Promise.all([completion, invoke('auth_open', { url: url.href })]);
    if (provider === 'chatgpt') await nativeRPC('chatgpt', { action: 'callback', url: callback });
    else {
      const value = new URL(callback);
      await nativeRPC('connectionFinish', {
        state: value.searchParams.get('state') ?? '',
        code: value.searchParams.get('code') ?? '',
        error: value.searchParams.get('error') ?? '',
        issuer: value.searchParams.get('iss') ?? '',
      });
    }
  } finally {
    authenticating = false;
    try {
      await invoke('auth_cancel');
    } finally {
      await synchronizeBackground();
    }
  }
}
