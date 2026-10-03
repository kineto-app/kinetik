import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ConversationStore } from '../src/core/conversation-store';
import { RuntimeHost } from '../src/core/host';
import { protocolVersion, reloadHint } from '../src/core/protocol';
import { recentTrace, traced } from '../src/core/trace';
import { exportArchive } from '../src/core/archive';
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
  await expect
    .poll(async () =>
      (await ask<{ conversations: Conversation[] }>({ op: 'state' })).conversations.every(
        (c) => c.status === 'idle',
      ),
    )
    .toBe(true);
  const state = await ask<{ conversations: Conversation[] }>({ op: 'state', conversation: a.id });
  const byId = Object.fromEntries(state.conversations.map((c) => [c.id, c]));
  expect(byId[a.id].messages.length).toBeGreaterThan(0);
  expect(byId[b.id].messages).toEqual([]);
  expect(byId[b.id].title).toBe(byId[a.id].title);
  const full = await ask<{ conversations: Conversation[] }>({ op: 'state' });
  expect(full.conversations.every((c) => c.messages.length > 0)).toBe(true);
});

test('each model request and tool call is traced, deleted with its chat and exported', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec printf hi');
  await runtime.run(c.id);
  const entries = await recentTrace(store);
  expect(entries.map((e) => `${e.kind}:${e.ok}`)).toEqual(
    expect.arrayContaining(['model:true', 'tool:true']),
  );
  expect(entries.every((e) => e.conversationId === c.id && e.ms >= 0)).toBe(true);
  expect(JSON.parse(await exportArchive(store)).trace).toHaveLength(entries.length);
  await runtime.deleteConversation(c.id);
  expect(await recentTrace(store)).toEqual([]);
});

test('a failed tool call is traced with its error', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/read /workspace/missing.txt');
  await runtime.run(c.id);
  const failed = (await recentTrace(store)).find((e) => !e.ok);
  expect(failed).toMatchObject({ kind: 'tool', name: 'read' });
  expect(failed?.error).toBeTruthy();
});

test('an error that echoes an API key is masked in the trace', async () => {
  const store = new Store(crypto.randomUUID());
  await expect(
    traced(store, { conversationId: 'c', kind: 'model', name: 'm' }, async () => {
      const openaiKey = 'sk-proj-' + crypto.randomUUID().replaceAll('-', '');
      const groqKey = 'gsk_' + crypto.randomUUID().replaceAll('-', '');
      throw new Error(`Invalid key ${openaiKey} or ${groqKey} here`);
    }),
  ).rejects.toThrow('sk-proj');
  expect((await recentTrace(store))[0].error).toBe('Invalid key [key] or [key] here');
});
