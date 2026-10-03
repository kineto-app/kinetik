import { loadChat } from '../chat';
import { expect, test } from 'vitest';
import { Runtime } from '../../src/core/runtime';
import { MemoryStore } from '../../src/core/memory-store';
import type { Model, ModelStep } from '../../src/core/types';

const say = (text: string): ModelStep => ({ type: 'text', text });

test('the core runs a turn in plain Node, with no IndexedDB', async () => {
  expect(typeof indexedDB).toBe('undefined');
  const store = new MemoryStore();
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec printf "hello" > note.txt && cat note.txt');
  await runtime.run(c.id);
  const saved = await loadChat(store, c.id);
  expect(saved.status).toBe('idle');
  expect(saved.messages.some((m) => m.role === 'tool' && m.text.includes('hello'))).toBe(true);
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/note.txt'))).toBe('hello');
});

test('an eval can script the model and resume after a restart on the same store', async () => {
  const store = new MemoryStore();
  const steps: ModelStep[] = [
    { type: 'tool', name: 'write', input: { path: '/workspace/a.md', content: 'A' }, callId: 'w' },
    say('Saved.'),
  ];
  const model: Model = { next: async () => steps.shift()! };
  const first = new Runtime(store, undefined, model);
  const c = await first.create();
  await first.submit(c.id, 'Save a file');
  await first.run(c.id);
  const second = new Runtime(store, undefined, { next: async () => say('Still here.') });
  await second.recover();
  await second.submit(c.id, 'Anything else?');
  await second.run(c.id);
  const saved = await loadChat(store, c.id);
  expect(saved.messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
    'Saved.',
    'Still here.',
  ]);
});

test('MemoryStore copies values, as IndexedDB does', async () => {
  const store = new MemoryStore();
  const value = { list: [1] };
  await store.put('k', value);
  value.list.push(2);
  expect(await store.get('k')).toEqual({ list: [1] });
  await store.update<{ list: number[] } | undefined>('k', () => undefined);
  expect(await store.keys('')).toEqual([]);
});
