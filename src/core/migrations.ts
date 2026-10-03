import type { Store } from '../browser/store';
import type { Plugins } from '../plugins/loader';
import type { ConversationStore } from './conversation-store';
import { withOutput } from './model-input';
import type { Conversation, InstalledPlugin } from './types';

export const schemaKey = 'meta:schema';
type Context = { store: Store; chats: ConversationStore; plugins: Plugins };
type Pinning = { plugins?: InstalledPlugin[] };

/** Each runs once, in order; an import clears the version, so they run again on imported data. */
const migrations: ((context: Context) => Promise<void>)[] = [
  async ({ store, chats }) => {
    for (const [, c] of await store.entries<Conversation>('conversation:'))
      if (c.modelInput && !c.input) await chats.update(c.id, (value) => value);
  },
  async ({ store }) => {
    for (const [key, c] of await store.entries<Conversation>('conversation:'))
      if (typeof c.turnModel === 'string')
        await store.update<Conversation>(key, (value) => ({
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
    for (const [, c] of await store.entries<Conversation>('conversation:')) {
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
      await chats.update(c.id, (value) =>
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
            },
      );
    }
  },
];

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
