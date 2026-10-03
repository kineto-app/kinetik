import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ConversationStore } from '../src/core/conversation-store';
import { RuntimeHost } from '../src/core/host';
import { protocolVersion, reloadHint } from '../src/core/protocol';
import type { Conversation } from '../src/core/types';

test('a chat whose saved history lost a part says so instead of retrying forever', async () => {
  const store = new Store(crypto.randomUUID());
  const c = await new Runtime(store).create();
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    input: { generation: 'g', segments: 2 },
  }));
  await store.put(`model-input:${c.id}:g:0`, [{ role: 'user', content: 'Hi' }]);
  const chats = new ConversationStore(store, () => {});
  await expect(chats.load(c.id)).rejects.toThrow('history is missing');
});

test('a send retried with the same id is saved once, attachments included', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  const photo = await runtime.stageAttachment(
    c.id,
    'a.jpg',
    new Uint8Array([1]),
    new Uint8Array([2]),
  );
  await runtime.submit(c.id, 'Look', 'send-0001', [photo.id]);
  await runtime.submit(c.id, 'Look', 'send-0001', [photo.id]);
  const saved = (await store.get<Conversation>('conversation:' + c.id))!;
  expect(saved.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  expect(saved.pending).toEqual(['send-0001']);
});

test('a window from another build is told to reload instead of being served', async () => {
  const host = new RuntimeHost(
    new Store(crypto.randomUUID()),
    new URL('https://app.test/'),
    () => {},
    {
      connections: {},
    },
  );
  const ask = (data: Record<string, unknown>) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => void host.handle(data, resolve));
  expect(await ask({ op: 'state' })).toEqual({ ok: false, error: reloadHint });
  expect(await ask({ op: 'state', protocol: protocolVersion + 1 })).toEqual({
    ok: false,
    error: reloadHint,
  });
  expect(await ask({ op: 'state', protocol: protocolVersion })).toMatchObject({ ok: true });
});

test('state sends messages only for the chat the window shows', async () => {
  const store = new Store(crypto.randomUUID());
  const host = new RuntimeHost(store, new URL('https://app.test/'), () => {}, { connections: {} });
  const ask = <T>(data: Record<string, unknown>) =>
    new Promise<T>(
      (resolve, reject) =>
        void host.handle({ ...data, protocol: protocolVersion }, (reply) =>
          reply.ok ? resolve(reply.result as T) : reject(new Error(reply.error)),
        ),
    );
  const a = await ask<Conversation>({ op: 'create' });
  const b = await ask<Conversation>({ op: 'create' });
  for (const id of [a.id, b.id]) await ask({ op: 'submit', id, text: '/write /workspace/x\nhi' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const state = await ask<{ conversations: Conversation[] }>({ op: 'state', conversation: a.id });
  const byId = Object.fromEntries(state.conversations.map((c) => [c.id, c]));
  expect(byId[a.id].messages.length).toBeGreaterThan(0);
  expect(byId[b.id].messages).toEqual([]);
  expect(byId[b.id].title).toBe(byId[a.id].title);
  const full = await ask<{ conversations: Conversation[] }>({ op: 'state' });
  expect(full.conversations.every((c) => c.messages.length > 0)).toBe(true);
});
