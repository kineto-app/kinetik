import type { Store } from '../browser/store';
import type { Conversation, InputSegments } from './types';

type Item = Record<string, unknown>;
export const conversationKey = (id: string) => `conversation:${id}`;
const key = conversationKey;
const segmentKey = (id: string, s: InputSegments, i: number) =>
  `model-input:${id}:${s.generation}:${i}`;
const sameSegments = (a?: InputSegments, b?: InputSegments) =>
  a?.generation === b?.generation && a?.segments === b?.segments;
const staleInput = new Error('Model input changed during the update.');

/** Conversation records with their model input kept in append-only segments. */
export class ConversationStore {
  /** Model input already read, valid while the stored segment count and generation match. */
  private inputs = new Map<string, { segments: InputSegments; items: Item[] }>();
  constructor(
    private store: Store,
    private changed: () => void,
  ) {}
  /** The conversation with its model input joined in. */
  async load(id: string): Promise<Conversation | undefined> {
    for (;;) {
      const c = await this.store.get<Conversation>(key(id));
      if (!c?.input) return c;
      const cached = this.inputs.get(id);
      if (cached && sameSegments(cached.segments, c.input))
        return { ...c, modelInput: cached.items };
      const segments = c.input;
      const parts = await this.store.getMany<Item[]>(
        Array.from({ length: segments.segments }, (_, i) => segmentKey(id, segments, i)),
      );
      // A missing segment means the input was replaced meanwhile; read again.
      if (parts.some((part) => !part)) continue;
      const items = (parts as Item[][]).flat();
      this.inputs.set(id, { segments, items });
      return { ...c, modelInput: items };
    }
  }
  /**
   * Updates a conversation and its model input in one transaction. Growth of the input is
   * written as one new segment holding only the added items; any other change starts a new
   * generation. Updaters see and return the joined `modelInput`.
   */
  async update(id: string, update: (c: Conversation) => Conversation): Promise<Conversation> {
    for (;;) {
      const view = await this.load(id);
      if (!view) throw new Error('Conversation not found.');
      let result!: Conversation;
      let items: Item[] | undefined;
      try {
        await this.store.updateMany([key(id)], ([stored]) => {
          const c = stored as Conversation | undefined;
          if (!c) throw new Error('Conversation not found.');
          if (!sameSegments(c.input, view.input)) throw staleInput;
          // Older builds kept the input inline; the first write moves it into segments.
          const base = c.input ? view.modelInput : c.modelInput;
          const { modelInput: next, ...rest } = update({ ...c, modelInput: base });
          const writes: [string, unknown][] = [];
          let segments = c.input;
          const appended =
            c.input &&
            base &&
            next &&
            next.length >= base.length &&
            base.every((item, i) => next[i] === item);
          if (appended) {
            if (next.length > base.length) {
              writes.push([segmentKey(id, segments!, segments!.segments), next.slice(base.length)]);
              segments = { ...segments!, segments: segments!.segments + 1 };
            }
          } else if (next !== base || (!c.input && next)) {
            for (let i = 0; i < (c.input?.segments ?? 0); i++)
              writes.push([segmentKey(id, c.input!, i), undefined]);
            segments = next ? { generation: crypto.randomUUID(), segments: 1 } : undefined;
            if (next) writes.push([segmentKey(id, segments!, 0), next]);
          }
          result = { ...rest, input: segments };
          items = segments ? (appended ? next : (next ?? base)) : undefined;
          writes.push([key(id), result]);
          return writes;
        });
      } catch (error) {
        if (error === staleInput) continue;
        throw error;
      }
      if (result.input && items) this.inputs.set(id, { segments: result.input, items });
      else this.inputs.delete(id);
      this.changed();
      return { ...result, modelInput: items };
    }
  }
}
