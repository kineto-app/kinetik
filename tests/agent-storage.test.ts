import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { compactPrompt } from '../src/core/compaction';
import { modelInput } from './model-input';
import type { Conversation, Model, ModelStep } from '../src/core/types';

/** Counts the bytes each write puts into storage, by key prefix. */
class CountingStore extends Store {
  writes: { key: string; bytes: number }[] = [];
  private count(key: string, value: unknown) {
    if (value !== undefined) this.writes.push({ key, bytes: JSON.stringify(value).length });
  }
  override async update<T>(key: string, update: (previous: T | undefined) => T): Promise<T> {
    return super.update<T>(key, (previous) => {
      const value = update(previous);
      this.count(key, value);
      return value;
    });
  }
  override async updateMany(keys: string[], update: (values: unknown[]) => [string, unknown][]) {
    return super.updateMany(keys, (values) => {
      const writes = update(values);
      for (const [key, value] of writes) this.count(key, value);
      return writes;
    });
  }
  bytes(prefix: string) {
    return this.writes.filter((w) => w.key.startsWith(prefix)).reduce((n, w) => n + w.bytes, 0);
  }
}

const blob = 'x'.repeat(200_000);
/** A first step carrying a large encrypted reasoning item, then nine small tool steps. */
function longTurn(): Model {
  let step = 0;
  return {
    async next(): Promise<ModelStep> {
      step++;
      if (step === 1)
        return {
          type: 'tool',
          name: 'list',
          input: { path: '/workspace' },
          callId: 'c1',
          items: [
            { type: 'reasoning', encrypted_content: blob },
            {
              type: 'function_call',
              call_id: 'c1',
              name: 'list',
              arguments: '{"path":"/workspace"}',
            },
          ],
        };
      if (step <= 10)
        return {
          type: 'tool',
          name: 'write',
          input: { path: `/workspace/${step}.txt`, content: String(step) },
          callId: 'c' + step,
          items: [{ type: 'function_call', call_id: 'c' + step, name: 'write', arguments: '{}' }],
        };
      return { type: 'text', text: 'Done.' };
    },
  };
}

test('a step writes only its new model input; a large item is written once', async () => {
  const store = new CountingStore(crypto.randomUUID());
  const runtime = new Runtime(store, undefined, longTurn());
  const c = await runtime.create();
  await runtime.submit(c.id, 'Do ten things');
  await runtime.run(c.id);
  const saved = (await store.get<Conversation>('conversation:' + c.id))!;
  expect(saved.messages.at(-1)?.text).toBe('Done.');
  expect(saved.modelInput).toBeUndefined();

  const blobWrites = store.writes.filter((w) => w.bytes >= blob.length);
  expect(blobWrites).toHaveLength(1);
  expect(blobWrites[0].key).toMatch(/^model-input:/);

  // What the same turn costs when every conversation write carries the whole input.
  const input = await modelInput(store, c.id);
  expect(input?.filter((item) => item.type === 'function_call_output')).toHaveLength(10);
  const conversationWrites = store.writes.filter((w) => w.key.startsWith('conversation:'));
  const inputBytes = JSON.stringify(input).length;
  const before = store.bytes('conversation:') + conversationWrites.length * inputBytes;
  const after = store.bytes('conversation:') + store.bytes('model-input:');
  console.log(
    `[storage] ${conversationWrites.length} conversation writes; inline input ≈ ${(before / 1024).toFixed(0)} KB, segmented ${(after / 1024).toFixed(0)} KB`,
  );
  expect(after).toBeLessThan(before / 10);
  expect(Math.max(...conversationWrites.map((w) => w.bytes))).toBeLessThan(20_000);
});

test('an older chat with inline input moves into segments on its next write', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store, undefined, {
    async next(request) {
      expect(request.history?.[0]).toEqual({ role: 'user', content: 'Earlier' });
      return { type: 'text', text: 'Hello again' };
    },
  });
  const c = await runtime.create();
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    modelInput: [{ role: 'user', content: 'Earlier' }],
  }));
  await runtime.submit(c.id, 'Hi');
  await runtime.run(c.id);
  const saved = (await store.get<Conversation>('conversation:' + c.id))!;
  expect(saved.modelInput).toBeUndefined();
  expect(saved.input?.segments).toBeGreaterThan(0);
  expect((await modelInput(store, c.id))?.slice(0, 2)).toEqual([
    { role: 'user', content: 'Earlier' },
    { role: 'user', content: 'Hi' },
  ]);
});

test('a summary replaces the input with a new generation and removes the old segments', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store, undefined, {
    async next(request) {
      if (request.message === compactPrompt) return { type: 'text', text: 'Notes.' };
      return {
        type: 'text',
        text: 'Answer',
        items: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Answer' }],
          },
        ],
        usage: { input: 9000, output: 10 },
        contextWindow: 10000,
      };
    },
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'One');
  await runtime.run(c.id);
  const first = (await store.get<Conversation>('conversation:' + c.id))!.input!;
  await runtime.submit(c.id, 'Two');
  await runtime.run(c.id);
  const second = (await store.get<Conversation>('conversation:' + c.id))!.input!;
  expect(second.generation).not.toBe(first.generation);
  const keys = (await store.entries('model-input:' + c.id)).map(([key]) => key);
  expect(keys.every((key) => key.includes(second.generation))).toBe(true);
  expect((await modelInput(store, c.id))?.[0]).toMatchObject({
    content: expect.stringContaining('Notes.'),
  });
});

test('a restarted runtime, or a second one writing the same chat, sees the full input', async () => {
  const store = new Store(crypto.randomUUID());
  const reply = (text: string): Model => ({
    async next() {
      return { type: 'text', text };
    },
  });
  const a = new Runtime(store, undefined, reply('A'));
  const c = await a.create();
  await a.submit(c.id, 'First');
  await a.run(c.id);
  // A second worker appends while the first still holds the earlier input in memory.
  const b = new Runtime(store, undefined, reply('B'));
  await b.submit(c.id, 'Second');
  await b.run(c.id);
  let seen: unknown[] = [];
  const a2 = new Runtime(store, undefined, {
    async next(request) {
      seen = request.history ?? [];
      return { type: 'text', text: 'C' };
    },
  });
  await a.submit(c.id, 'Third');
  await a2.run(c.id);
  expect(seen.filter((item) => (item as { role?: string }).role === 'user')).toEqual([
    { role: 'user', content: 'First' },
    { role: 'user', content: 'Second' },
    { role: 'user', content: 'Third' },
  ]);
});
