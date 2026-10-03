import { expect, test } from 'vitest';
import { MemoryStore } from '../src/core/memory-store';
import { memoryChangeKey, saveMemory, undoMemory } from '../src/core/memory';

test('a memory change can be undone once, and never over a newer change', async () => {
  const store = new MemoryStore();
  await saveMemory(store, 'Likes coral.', 'you');
  await saveMemory(store, 'Likes coral. Writes in Russian.', 'kinetik', 'chat-1');
  expect(await store.get(memoryChangeKey)).toMatchObject({
    by: 'kinetik',
    conversationId: 'chat-1',
    previous: 'Likes coral.',
  });
  // Saving the same text again, as a re-run after a restart does, keeps the change to undo.
  await saveMemory(store, 'Likes coral. Writes in Russian.', 'kinetik', 'chat-1');
  await undoMemory(store);
  expect(await store.get('memory')).toBe('Likes coral.');
  expect(await store.get(memoryChangeKey)).toBeUndefined();

  await saveMemory(store, 'A', 'kinetik');
  await store.put('memory', 'Edited elsewhere');
  await undoMemory(store);
  expect(await store.get('memory')).toBe('Edited elsewhere');
});
