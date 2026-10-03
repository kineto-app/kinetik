import type { Store } from './ports';
import type { Conversation, InputSegments } from './types';

type Item = unknown;
export const conversationKey = (id: string) => `conversation:${id}`;
const key = conversationKey;

/** The two lists stored in append-only segments next to the conversation record. */
const lists = [
  { list: 'modelInput', meta: 'input', prefix: 'model-input' },
  { list: 'messages', meta: 'log', prefix: 'messages' },
] as const;
type List = (typeof lists)[number];
const segmentKey = (l: List, id: string, s: InputSegments, i: number) =>
  `${l.prefix}:${id}:${s.generation}:${i}`;
const sameSegments = (a?: InputSegments, b?: InputSegments) =>
  a?.generation === b?.generation && a?.segments === b?.segments;
const staleInput = new Error('Stored lists changed during the update.');
type Record_ = Conversation & Partial<Record<List['meta'], InputSegments>>;

/**
 * Conversation records whose model input and messages live in append-only segments, so a step
 * writes only what it added instead of the whole chat.
 */
export class ConversationStore {
  /** Lists already read, valid while the stored segment count and generation match. */
  private cache = new Map<string, { segments: InputSegments; items: Item[] }>();
  constructor(
    private store: Store,
    private changed: (conversationId: string) => void,
  ) {}
  /** The conversation with its model input and messages joined in. */
  async load(id: string): Promise<Conversation | undefined> {
    read: for (;;) {
      const c = await this.store.get<Record_>(key(id));
      if (!c) return undefined;
      const view: Record<string, unknown> = { ...c };
      for (const l of lists) {
        const segments = c[l.meta];
        // Older records kept the list inline; the first write moves it into segments.
        if (!segments) continue;
        const cached = this.cache.get(l.list + ':' + id);
        if (cached && sameSegments(cached.segments, segments)) {
          view[l.list] = cached.items;
          continue;
        }
        const parts = await this.store.getMany<Item[]>(
          Array.from({ length: segments.segments }, (_, i) => segmentKey(l, id, segments, i)),
        );
        if (parts.some((part) => !part)) {
          // Replaced meanwhile: read again. Missing from a record that did not change: it is lost.
          const now = await this.store.get<Record_>(key(id));
          if (now?.[l.meta] && sameSegments(now[l.meta], segments))
            throw new Error(
              'Part of this chat’s history is missing. Start a new chat to continue.',
            );
          continue read;
        }
        const items = (parts as Item[][]).flat();
        this.cache.set(l.list + ':' + id, { segments, items });
        view[l.list] = items;
      }
      view.messages ??= [];
      return view as unknown as Conversation;
    }
  }
  /**
   * Updates a conversation and its lists in one transaction. Growth of a list is written as one
   * new segment holding only the added items; any other change starts a new generation.
   * Updaters see and return the joined lists.
   */
  async update(id: string, update: (c: Conversation) => Conversation): Promise<Conversation> {
    for (;;) {
      const view = (await this.load(id)) as Record_ | undefined;
      if (!view) throw new Error('Conversation not found.');
      let result!: Record<string, unknown>;
      const joined = new Map<List, Item[] | undefined>();
      try {
        await this.store.updateMany([key(id)], ([stored]) => {
          const c = stored as Record_ | undefined;
          if (!c) throw new Error('Conversation not found.');
          if (lists.some((l) => !sameSegments(c[l.meta], view[l.meta]))) throw staleInput;
          const bases = new Map(
            lists.map((l) => [l, (c[l.meta] ? view[l.list] : c[l.list]) as Item[] | undefined]),
          );
          const next = update({
            ...c,
            modelInput: bases.get(lists[0]),
            messages: bases.get(lists[1]) ?? [],
          } as Conversation) as unknown as Record<string, unknown>;
          const writes: [string, unknown][] = [];
          result = { ...next };
          for (const l of lists) {
            const base = bases.get(l);
            const items = next[l.list] as Item[] | undefined;
            delete result[l.list];
            let segments = c[l.meta];
            const appended =
              segments &&
              base &&
              items &&
              items.length >= base.length &&
              base.every((item, i) => items[i] === item);
            if (appended) {
              if (items.length > base.length) {
                writes.push([
                  segmentKey(l, id, segments!, segments!.segments),
                  items.slice(base.length),
                ]);
                segments = { ...segments!, segments: segments!.segments + 1 };
              }
            } else if (items !== base || (!segments && items)) {
              for (let i = 0; i < (segments?.segments ?? 0); i++)
                writes.push([segmentKey(l, id, segments!, i), undefined]);
              segments = items ? { generation: crypto.randomUUID(), segments: 1 } : undefined;
              if (items) writes.push([segmentKey(l, id, segments!, 0), items]);
            }
            result[l.meta] = segments;
            joined.set(l, segments ? (appended ? items : (items ?? base)) : undefined);
          }
          writes.push([key(id), result]);
          return writes;
        });
      } catch (error) {
        if (error === staleInput) continue;
        throw error;
      }
      for (const l of lists) {
        const segments = result[l.meta] as InputSegments | undefined;
        const items = joined.get(l);
        if (segments && items) this.cache.set(l.list + ':' + id, { segments, items });
        else this.cache.delete(l.list + ':' + id);
      }
      this.changed(id);
      return {
        ...result,
        modelInput: joined.get(lists[0]),
        messages: joined.get(lists[1]) ?? [],
      } as unknown as Conversation;
    }
  }
}
