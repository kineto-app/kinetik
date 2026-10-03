import type { Store } from '../browser/store';
import { abortable } from './abortable';
import { ContextOverflow } from './connection-error';
import type { ConversationStore } from './conversation-store';
import { message, type LiveProgress, type Model, type ModelRequest, type ModelStep } from './types';

/** Context limits and the summary that replaces older model input. */
export const defaultContextWindow = 200_000;
/** Compact once the latest request used this share of the usable window. */
export const compactAt = 0.75;
export const summaryPrefix = 'Summary of the earlier conversation:\n';
export const compactPrompt =
  'Summarise the conversation so far for your own future reference. Keep the user’s goals and preferences, decisions, facts and names, file paths and URLs, what was done and what remains. Write plain notes, at most 400 words. Do not call tools.';

/** Rough size for requests that report no usage; JSON overstates encrypted blobs, which is safe. */
export const estimateTokens = (input: unknown) =>
  Math.ceil(
    // An image costs roughly a thousand tokens, not its base64 length.
    JSON.stringify(input ?? []).replace(
      /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g,
      'x'.repeat(4000),
    ).length / 4,
  );

/**
 * Where the kept tail starts: the latest user item, so the current request and every call
 * made for it stay verbatim and no function call is separated from its output.
 */
export function splitPoint(input: Record<string, unknown>[]): number {
  for (let i = input.length - 1; i > 0; i--) if (input[i].role === 'user') return i;
  return 0;
}

type Item = Record<string, unknown>;
type CompactorDeps = {
  store: Store;
  chats: ConversationStore;
  model: Model;
  pin: (id: string) => Promise<string | undefined>;
  ask: (id: string, request: ModelRequest, signal: AbortSignal) => Promise<ModelStep>;
  live: Map<string, LiveProgress>;
  progress: (id: string, live: LiveProgress) => void;
  changed: () => void;
};

/** Keeps a conversation's model input inside the context window. */
export class Compactor {
  constructor(private deps: CompactorDeps) {}
  /** Provider compaction when available and not known to fail for this model; else undefined. */
  private async serverCompact(input: Item[], pin: string | undefined, signal: AbortSignal) {
    if (
      !this.deps.model.compact ||
      (await this.deps.store.get('no-server-compact:' + (pin ?? 'chatgpt')))
    )
      return undefined;
    try {
      const output = await abortable(this.deps.model.compact(input, pin, signal), signal);
      return Array.isArray(output) &&
        output.length &&
        output.every((item) => item && typeof item === 'object' && !Array.isArray(item))
        ? output
        : undefined;
    } catch (error) {
      signal.throwIfAborted();
      return undefined;
    }
  }
  /**
   * The first request after a provider compaction was rejected: put the archived input back,
   * stop using provider compaction for this model, and let the step run again.
   */
  async undoServerCompaction(id: string): Promise<boolean> {
    const c = await this.deps.chats.load(id);
    if (!c?.serverCompaction) return false;
    const { n, head } = c.serverCompaction;
    const archived = await this.deps.store.get<Item[]>(`model-archive:${id}:${n}`);
    if (!archived) return false;
    await this.deps.store.put('no-server-compact:' + (c.turnModel ?? 'chatgpt'), true);
    await this.deps.chats.update(id, (value) =>
      value.serverCompaction?.n !== n
        ? value
        : {
            ...value,
            serverCompaction: undefined,
            modelInput: [...archived, ...(value.modelInput ?? []).slice(head)],
            context: undefined,
          },
    );
    return true;
  }
  async compactIfNeeded(id: string, signal: AbortSignal) {
    const c = await this.deps.chats.load(id);
    const window = c?.context?.window ?? defaultContextWindow;
    const tokens = c?.context?.tokens ?? estimateTokens(c?.modelInput);
    if (tokens >= window * compactAt) await this.compactInput(id, signal);
  }
  /**
   * Replaces model input before the latest user request with a model-written summary. The older
   * part is archived first and the swap is one write, so redoing it after a crash is harmless.
   */
  async compactInput(id: string, signal: AbortSignal): Promise<boolean> {
    const previous = this.deps.live.get(id);
    this.deps.progress(id, { step: previous?.step ?? 0, activity: 'summarising' });
    try {
      return await this.summarise(id, signal);
    } finally {
      if (previous) this.deps.progress(id, previous);
      else {
        this.deps.live.delete(id);
        this.deps.changed();
      }
    }
  }
  private async summarise(id: string, signal: AbortSignal): Promise<boolean> {
    const c = await this.deps.chats.load(id);
    const input = c?.modelInput ?? [];
    if (!c || c.call?.state === 'pending') return false;
    let cut = splitPoint(input);
    if (cut < 2) return false;
    const pin = await this.deps.pin(id);
    let head = await this.serverCompact(input.slice(0, cut), pin, signal);
    const server = Boolean(head);
    let summary: string | undefined;
    // An older part that itself overflows is shortened from the start until it fits.
    for (let start = 0; !head && summary === undefined && start < cut;) {
      try {
        const step = await abortable(
          this.deps.ask(
            id,
            {
              message: compactPrompt,
              instructions: 'You write compact working notes about a conversation.',
              tools: [],
              definitions: {},
              history: [...input.slice(start, cut), { role: 'user', content: compactPrompt }],
            },
            signal,
          ),
          signal,
        );
        if (step.type !== 'text') throw new Error('The summary request called a tool.');
        summary = step.text;
      } catch (error) {
        if (!(error instanceof ContextOverflow)) throw error;
        start =
          splitPoint(input.slice(0, Math.max(start + 2, Math.floor((start + cut) / 2)))) || cut;
        if (start >= cut) return false;
      }
    }
    head ??= [{ role: 'user', content: summaryPrefix + summary }];
    const n = (c.compactions ?? 0) + 1;
    await this.deps.store.put(`model-archive:${id}:${n}`, input.slice(0, cut));
    const before = c.context?.tokens ?? estimateTokens(input);
    let applied = false;
    await this.deps.chats.update(id, (value) => {
      const current = value.modelInput ?? [];
      // Only append-only growth is expected; anything else means another writer replaced it.
      if (current.length < input.length || value.compactions !== c.compactions) return value;
      applied = true;
      const next = [...head!, ...current.slice(cut)];
      return {
        ...value,
        modelInput: next,
        compactions: n,
        serverCompaction: server ? { n, head: head!.length } : undefined,
        context: {
          tokens: estimateTokens(next),
          window: value.context?.window ?? defaultContextWindow,
        },
        messages: [
          ...value.messages,
          {
            ...message(
              'notice',
              server
                ? 'ChatGPT summarised earlier messages to keep this chat fast. Only ChatGPT can read this summary; a custom model will not see the earlier messages.'
                : 'Summarised earlier messages to keep this chat fast.',
            ),
            compaction: { items: cut, tokens: before },
          },
        ],
      };
    });
    return applied;
  }
}
