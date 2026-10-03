import type { Store } from './ports';
import type { Plugins } from '../plugins/loader';
import type { ConversationStore } from './conversation-store';
import { withOutput } from './model-input';
import type { Conversation, InstalledPlugin, ToolCall, Turn, TurnPin, Usage } from './types';

export const schemaKey = 'meta:schema';
type Context = { store: Store; chats: ConversationStore; plugins: Plugins };
type Pinning = { plugins?: InstalledPlugin[] };
/** A conversation as builds before schema 5 stored it: the turn's fields sat flat on it. */
type Legacy = Omit<Conversation, 'turn'> & {
  turn?: Turn | 'foreground' | 'background';
  activeMessage?: string;
  workStartedAt?: number;
  turnModel?: TurnPin | string;
  turnUsage?: Usage;
  call?: Omit<ToolCall, 'state'> & { state: string; approved?: boolean };
};
const flatFields = ['activeMessage', 'workStartedAt', 'turnModel', 'turnUsage', 'call'] as const;

/** Old `pending` meant "may have started" unless the user had approved it and it had not run. */
function turnOf(c: Legacy): Turn | undefined {
  const { approved, ...call } = c.call ?? { approved: undefined };
  const state = c.call?.state === 'pending' ? (approved ? 'approved' : 'started') : c.call?.state;
  const turn: Turn = {
    kind: typeof c.turn === 'string' ? c.turn : undefined,
    message: c.activeMessage,
    startedAt: c.workStartedAt,
    model: typeof c.turnModel === 'object' ? c.turnModel : undefined,
    usage: c.turnUsage,
    call: c.call && ({ ...call, state } as ToolCall),
  };
  const kept = Object.entries(turn).filter(([, value]) => value !== undefined);
  return kept.length ? (Object.fromEntries(kept) as Turn) : undefined;
}

/** Each runs once, in order; an import clears the version, so they run again on imported data. */
const migrations: ((context: Context) => Promise<void>)[] = [
  async ({ store, chats }) => {
    for (const [, c] of await store.entries<Conversation>('conversation:'))
      if (c.modelInput && !c.input) await chats.update(c.id, (value) => value);
  },
  async ({ store }) => {
    for (const [key, c] of await store.entries<Legacy>('conversation:'))
      if (typeof c.turnModel === 'string')
        await store.update<Legacy>(key, (value) => ({
          ...value!,
          turnModel: { provider: String(value!.turnModel) === 'custom' ? 'custom' : 'chatgpt' },
        }));
  },
  async ({ store, plugins }) => {
    for (const prefix of ['conversation:', 'background:', 'app:'])
      for (const [key, record] of await store.entries<Pinning>(prefix))
        if (record.plugins?.some((plugin) => plugin.code)) {
          const pinned = await plugins.pin(record.plugins);
          await store.update<Pinning>(key, (value) => ({ ...value!, plugins: pinned }));
        }
  },
  // Older builds sent a background tool rejected before it ran to review; let the model continue.
  async ({ store, chats }) => {
    for (const [, c] of await store.entries<Legacy>('conversation:')) {
      const last = c.messages.at(-1);
      if (
        c.status !== 'needs_review' ||
        c.call?.state !== 'unknown' ||
        c.call.name !== 'background' ||
        c.call.provider !== 'local' ||
        last?.role !== 'notice' ||
        !last.text.startsWith('Tool outcome needs review: Tool is unavailable for background') ||
        (await store.get('background:' + c.call.id))
      )
        continue;
      const result = JSON.stringify({
        started: false,
        error: 'The background tool was rejected before execution. Choose an available tool.',
      });
      await chats.update(c.id, (current) => {
        const value = current as Legacy;
        return (
          value.status !== 'needs_review' || value.call?.id !== c.call!.id
            ? value
            : {
                ...value,
                status: 'queued',
                call: { ...value.call!, state: 'completed', result },
                messages: value.messages.map((item) =>
                  item.id === last.id ? { ...item, visibility: 'internal' } : item,
                ),
                modelInput: withOutput(value.modelInput, value.call?.callId, result),
              }
        ) as Conversation;
      });
    }
  },
  // Schema 5 groups the turn's fields under `turn` and names every call state.
  async ({ store }) => {
    for (const [key, c] of await store.entries<Legacy>('conversation:'))
      if (typeof c.turn === 'string' || flatFields.some((field) => field in c))
        await store.update<Legacy>(key, (value) => {
          const rest = { ...value! };
          for (const field of flatFields) delete rest[field];
          return { ...rest, turn: turnOf(value!) };
        });
  },
];

export const schemaVersion = migrations.length;

export async function migrate(context: Context) {
  const run = async () => {
    const from = (await context.store.get<number>(schemaKey)) ?? 0;
    for (let version = from; version < migrations.length; version++) {
      await migrations[version](context);
      await context.store.put(schemaKey, version + 1);
    }
  };
  if (globalThis.navigator?.locks) await navigator.locks.request('kinetik-migrations', run);
  else await run();
}
