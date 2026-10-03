import { expect, test, vi } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { schemaVersion } from '../src/core/migrations';
import { CountingStore } from './counting-store';
import { loadChat } from './chat';

const chat = (store: Store, id: string) => store.get<Record<string, unknown>>('conversation:' + id);

test('a new message is written alone; the chat record and older messages are not rewritten', async () => {
  const store = new CountingStore(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  for (let i = 0; i < 5; i++) {
    await runtime.submit(c.id, `/exec printf "${'x'.repeat(2000)}${i}"`);
    await runtime.run(c.id);
  }
  store.writes.length = 0;
  await runtime.submit(c.id, '/exec printf "last"');
  await runtime.run(c.id);
  const record = store.writes.filter((w) => w.key === 'conversation:' + c.id);
  expect(Math.max(...record.map((w) => w.bytes))).toBeLessThan(2000);
  expect(store.bytes('messages:')).toBeLessThan(2000);
  expect((await chat(store, c.id))?.messages).toBeUndefined();
  expect((await loadChat(store, c.id)).messages.filter((m) => m.role === 'user')).toHaveLength(6);
});

test('Stop marking a queued message rewrites the messages once and leaves no old parts', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec printf one');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'later', undefined, [], 'after');
  await runtime.stop(c.id);
  const saved = await loadChat(store, c.id);
  expect(saved.messages.find((m) => m.text === 'later')?.unsent).toBe(true);
  const log = (await chat(store, c.id))?.log as { generation: string };
  expect((await store.keys(`messages:${c.id}:`)).every((key) => key.includes(log.generation))).toBe(
    true,
  );
});

test('migration 6 moves the messages of an older chat into segments, even after a restart', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await store.put('meta:schema', 5);
  const messages = [{ id: 'm1', role: 'user', text: 'Hello', createdAt: 1 }];
  await store.put('conversation:' + c.id, {
    ...(await chat(store, c.id)),
    log: undefined,
    messages,
  });
  // A worker killed during the migration saved no version; the next one runs it again.
  const write = vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('killed'));
  await new Runtime(store).recover();
  write.mockRestore();
  await new Runtime(store).recover();
  expect(await store.get('meta:schema')).toBe(schemaVersion);
  expect((await chat(store, c.id))?.messages).toBeUndefined();
  expect((await loadChat(store, c.id)).messages).toEqual(messages);
});

test('the chat list reads no messages for chats the window does not show', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const a = await runtime.create();
  const b = await runtime.create();
  for (const id of [a.id, b.id]) {
    await runtime.submit(id, '/exec printf hi');
    await runtime.run(id);
  }
  const reads = vi.spyOn(store, 'getMany');
  const list = await runtime.conversations((id) => id === a.id);
  const read = reads.mock.calls.flatMap(([keys]) => keys);
  reads.mockRestore();
  expect(read.some((key) => key.startsWith(`messages:${b.id}:`))).toBe(false);
  expect(list.find((c) => c.id === b.id)?.messages).toEqual([]);
  expect(list.find((c) => c.id === a.id)?.messages.length).toBeGreaterThan(0);
});
