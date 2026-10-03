import type { Store } from '../src/browser/store';
import type { Conversation } from '../src/core/types';

/** The stored model input of a conversation, joined from its segments. */
export async function modelInput(store: Store, id: string) {
  const c = await store.get<Conversation>('conversation:' + id);
  if (!c?.input) return c?.modelInput;
  const { generation, segments } = c.input;
  const parts = await store.getMany<Record<string, unknown>[]>(
    Array.from({ length: segments }, (_, i) => `model-input:${id}:${generation}:${i}`),
  );
  return parts.flatMap((part) => part ?? []);
}
