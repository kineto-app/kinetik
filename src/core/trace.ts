import type { Store } from '../browser/store';

/** One model request or tool call, kept on this device to explain what a turn did. */
export type TraceEntry = {
  at: number;
  conversationId: string;
  kind: 'model' | 'tool';
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
};

export const traceKey = (conversationId: string) => 'trace:' + conversationId;
const kept = 200;

/** Never fails the work it describes. */
export async function trace(store: Store, entry: TraceEntry) {
  await store
    .update<TraceEntry[]>(traceKey(entry.conversationId), (list) =>
      [...(list ?? []), entry].slice(-kept),
    )
    .catch(() => {});
}

/** Newest first, across chats. */
export async function recentTrace(store: Store, limit = 100) {
  return (await store.entries<TraceEntry[]>('trace:'))
    .flatMap(([, list]) => list)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Times `work` and records it, success or failure. */
export async function traced<T>(
  store: Store,
  entry: Pick<TraceEntry, 'conversationId' | 'kind' | 'name'>,
  work: () => Promise<T>,
): Promise<T> {
  const at = Date.now();
  try {
    const result = await work();
    await trace(store, { ...entry, at, ok: true, ms: Date.now() - at });
    return result;
  } catch (error) {
    const text = (error instanceof Error ? error.message : String(error))
      // An export leaves the device, so anything shaped like an API key is masked.
      .replace(/\b(?:sk|rk|pk|gsk|ghp|gho|xox[abp])[-_][\w-]{8,}|\bAIza[\w-]{20,}/g, '[key]')
      .slice(0, 300);
    await trace(store, { ...entry, at, ok: false, ms: Date.now() - at, error: text });
    throw error;
  }
}
