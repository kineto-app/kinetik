import { protocolVersion } from '../../src/core/protocol';
import type { Page } from '@playwright/test';
export async function rpc<T>(
  page: Page,
  op: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  return page.evaluate(
    async ({ op, data, protocol }) => {
      const registration = await navigator.serviceWorker.ready;
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('RPC timed out')), 15000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          channel.port1.close();
          event.data.ok ? resolve(event.data.result) : reject(new Error(event.data.error));
        };
        registration.active!.postMessage({ op, ...data, protocol }, [channel.port2]);
      });
    },
    { op, data, protocol: protocolVersion },
  ) as Promise<T>;
}
export async function attachmentPath(page: Page, name: string) {
  const state = await rpc<{
    conversations: { messages: { attachments?: { name: string; path: string }[] }[] }[];
  }>(page, 'state');
  const file = state.conversations
    .flatMap((c) => c.messages.flatMap((m) => m.attachments ?? []))
    .find((f) => f.name === name);
  if (!file) throw new Error('Attachment was not sent: ' + name);
  return file.path;
}
