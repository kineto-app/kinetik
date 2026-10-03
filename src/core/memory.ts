import type { Store } from './ports';

export const memoryKey = 'memory';
/** The last change to the memory: who made it, where, and the text before it, for Undo. */
export interface MemoryChange {
  by: 'kinetik' | 'you';
  at: number;
  conversationId?: string;
  previous: string;
  text: string;
}
export const memoryChangeKey = 'memory-change';

/** Saves the memory and records the change in one write. Saving the same text changes nothing. */
export async function saveMemory(
  store: Store,
  text: string,
  by: MemoryChange['by'],
  conversationId?: string,
) {
  await store.updateMany([memoryKey], ([current]) => {
    const previous = (current as string | undefined) ?? '';
    if (previous === text) return [];
    const change: MemoryChange = { by, at: Date.now(), conversationId, previous, text };
    return [
      [memoryKey, text],
      [memoryChangeKey, change],
    ];
  });
}

/** Puts back the text before the last change, unless the memory changed again since. */
export async function undoMemory(store: Store) {
  await store.updateMany([memoryKey, memoryChangeKey], ([current, change]) => {
    const last = change as MemoryChange | undefined;
    if (!last || (current ?? '') !== last.text) return [];
    return [
      [memoryKey, last.previous],
      [memoryChangeKey, undefined],
    ];
  });
}
