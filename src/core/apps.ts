import type { Store } from '../browser/store';
import type { Plugins } from '../plugins/loader';
import type { ConversationStore } from './conversation-store';
import { printable } from './model-input';
import { toolOutcome } from './tool-outcome';
import { message, type InstalledPlugin } from './types';

/** Tool calls made by MCP App widgets, journaled like the agent's own calls. */
export class AppCalls {
  private active = new Set<string>();
  constructor(
    private store: Store,
    private chats: ConversationStore,
    private plugins: Plugins,
  ) {}
  running(key: string) {
    return this.active.has(key);
  }
  async call(id: string, name: string, input: Record<string, unknown>): Promise<unknown> {
    const record = await this.store.get<{
      plugins: InstalledPlugin[];
      tool: string;
      conversationId: string;
      provider: string;
    }>('app:' + id);
    if (!record) throw new Error('App not found.');
    if (name.length > 128 || JSON.stringify(input).length > 1024 * 1024)
      throw new Error('App request is too large.');
    const installed = (await this.plugins.list()).find(
      (plugin) => plugin.manifest.id === record.provider,
    );
    if (!installed || installed.enabledAt === null)
      throw new Error('This app’s plugin was disabled. Enable it and run its tool again.');
    // Saved widgets outlive plugin updates; their calls go through the version installed now.
    const snapshot = await this.plugins.snapshot(
      {},
      record.plugins.map((plugin) =>
        plugin.manifest.id === installed.manifest.id ? installed : plugin,
      ),
    );
    const tool = snapshot.bindings[record.tool]?.tool;
    if (!tool?.app) throw new Error('App tool unavailable.');
    const callId = crypto.randomUUID();
    this.active.add('app-call:' + callId);
    try {
      await this.store.put('app-call:' + callId, {
        appId: id,
        conversationId: record.conversationId,
        name,
        input,
        state: 'pending',
      });
      const result = await tool.app.call(name, input, AbortSignal.timeout(30000));
      await this.store.put('app-call:' + callId, {
        appId: id,
        name,
        input,
        state: 'completed',
        result,
      });
      await this.chats.update(record.conversationId, (value) => ({
        ...value,
        messages: [
          ...value.messages,
          {
            ...message('tool', printable(result), 'App · ' + name),
            activity: { scope: 'app:' + id, input, outcome: toolOutcome(result) },
          },
        ],
      }));
      return result;
    } catch (error) {
      await this.store.put('app-call:' + callId, { appId: id, name, input, state: 'unknown' });
      await this.chats.update(record.conversationId, (value) => ({
        ...value,
        messages: [
          ...value.messages,
          message(
            'notice',
            'App tool outcome unknown: ' + name + '. Check its effects before trying again.',
          ),
        ],
      }));
      throw error;
    } finally {
      this.active.delete('app-call:' + callId);
    }
  }
}
