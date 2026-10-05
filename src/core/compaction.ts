import type { Store } from './ports';
import { openCall } from './turn';
import { abortable } from './abortable';
import { ContextOverflow, ModelFailure } from './connection-error';
import type { ConversationStore } from './conversation-store';
import {
  message,
  type LiveProgress,
  type Model,
  type ModelRequest,
  type ModelStep,
  type TurnPin,
  type Conversation,
} from './types';

/** Context limits and the summary that replaces older model input. */
export const defaultContextWindow = 200_000;
/** Compact before the next request once the latest one used this share of the usable window. */
export const compactAt = 0.75;
/** From this share a local summary starts in the background while the turn goes on. */
export const backgroundAt = 0.6;
/** The newest model input kept verbatim, as a share of the window. */
const keepShare = 0.25;
/** Old tool outputs longer than this keep only their start and end. */
const longOutput = 2000;
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

const lastUser = (input: Record<string, unknown>[]) => {
  for (let i = input.length - 1; i > 0; i--) if (input[i].role === 'user') return i;
  return 0;
};
/** A model step begins here: never between a function call and its output. */
const stepStart = (input: Record<string, unknown>[], i: number) =>
  input[i].type !== 'function_call_output' && input[i - 1]?.type === 'function_call_output';

/**
 * Where the kept tail starts. Normally the latest user item, so the current request stays
 * verbatim. A turn too long for `keepTokens` is cut at the oldest step that leaves a tail that fits.
 */
export function splitPoint(input: Record<string, unknown>[], keepTokens = Infinity): number {
  const user = lastUser(input);
  if (estimateTokens(input.slice(user)) <= keepTokens) return user;
  for (let i = user + 1; i < input.length; i++)
    if (stepStart(input, i) && estimateTokens(input.slice(i)) <= keepTokens) return i;
  return user;
}

/** Keeps the start and end of long tool outputs before `keepFrom`; the rest of the turn is untouched. */
export function shortenOutputs(input: Record<string, unknown>[], keepFrom: number) {
  return input.map((item, i) => {
    const output = item.output;
    if (i >= keepFrom || item.type !== 'function_call_output' || typeof output !== 'string')
      return item;
    if (output.length <= longOutput) return item;
    const left = output.length - 1600;
    return {
      ...item,
      output: `${output.slice(0, 1200)}\n[… ${left} characters left out to save room …]\n${output.slice(-400)}`,
    };
  });
}

type Item = Record<string, unknown>;
/** Another compaction, or the undo of one, replaced the input since `before` was read. */
const changed = (now: Conversation, before: Conversation) =>
  now.compactions !== before.compactions || now.serverCompaction?.n !== before.serverCompaction?.n;
const noServerCompact = (pin?: TurnPin) =>
  `no-server-compact:${pin?.provider ?? 'chatgpt'}:${pin?.model ?? ''}`;
type CompactorDeps = {
  store: Store;
  chats: ConversationStore;
  model: Model;
  pin: (id: string) => Promise<TurnPin | undefined>;
  ask: (id: string, request: ModelRequest, signal: AbortSignal) => Promise<ModelStep>;
  live: Map<string, LiveProgress>;
  progress: (id: string, live: LiveProgress) => void;
  changed: () => void;
};

/** Keeps a conversation's model input inside the context window. */
export class Compactor {
  constructor(private deps: CompactorDeps) {}
  /** Provider compaction when available and not known to fail for this model; else undefined. */
  private async serverCompact(input: Item[], pin: TurnPin | undefined, signal: AbortSignal) {
    if (!this.deps.model.compact || (await this.deps.store.get(noServerCompact(pin))))
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
    await this.deps.store.put(noServerCompact(c.turn?.model), true);
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
  private running = new Map<string, Promise<boolean>>();
  /**
   * Before a request: long old tool outputs are shortened first, which costs no model call. A
   * summary then starts in the background, and the request waits for one only near the limit.
   */
  async compactIfNeeded(id: string, signal: AbortSignal) {
    const c = await this.deps.chats.load(id);
    const window = c?.context?.window ?? defaultContextWindow;
    let tokens = c?.context?.tokens ?? estimateTokens(c?.modelInput);
    if (tokens < window * backgroundAt) return;
    if (await this.shorten(id, window)) {
      tokens = estimateTokens((await this.deps.chats.load(id))?.modelInput);
      if (tokens < window * backgroundAt) return;
    }
    const pending = this.running.get(id);
    if (tokens >= window * compactAt) {
      await (pending ?? this.compactInput(id, signal));
      return;
    }
    if (pending) return;
    const summary = this.summarise(id, signal, true)
      .catch(() => false)
      .finally(() => this.running.delete(id));
    this.running.set(id, summary);
  }
  /** Shortens old tool outputs in one write; false when nothing was long enough. */
  private async shorten(id: string, window: number): Promise<boolean> {
    const c = await this.deps.chats.load(id);
    const input = c?.modelInput ?? [];
    const keepFrom = splitPoint(input, window * keepShare);
    const shortened = shortenOutputs(input, keepFrom);
    if (shortened.every((item, i) => item === input[i])) return false;
    let applied = false;
    await this.deps.chats.update(id, (value) => {
      const current = value.modelInput ?? [];
      if (current.length < input.length || changed(value, c!)) return value;
      applied = true;
      const next = [...shortened, ...current.slice(input.length)];
      return {
        ...value,
        modelInput: next,
        context: value.context && { ...value.context, tokens: estimateTokens(next) },
      };
    });
    return applied;
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
  /** In the background only a local summary is used: ChatGPT's needs the very next request. */
  private async summarise(id: string, signal: AbortSignal, background = false): Promise<boolean> {
    const c = await this.deps.chats.load(id);
    const input = c?.modelInput ?? [];
    if (!c || openCall(c.turn?.call)) return false;
    const window = c.context?.window ?? defaultContextWindow;
    let cut = splitPoint(input, window * keepShare);
    if (cut < 2) return false;
    // Cut inside one long turn: its request stays verbatim right after the summary.
    const user = lastUser(input);
    const request = cut > user ? [input[user]] : [];
    const pin = await this.deps.pin(id);
    let head = background ? undefined : await this.serverCompact(input.slice(0, cut), pin, signal);
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
        if (step.type !== 'text') throw new ModelFailure('The summary request called a tool.');
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
      if (current.length < input.length || changed(value, c)) return value;
      applied = true;
      const next = [...head!, ...request, ...current.slice(cut)];
      return {
        ...value,
        modelInput: next,
        compactions: n,
        serverCompaction: server ? { n, head: head!.length + request.length } : undefined,
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
