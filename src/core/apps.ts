import type { Store } from './ports';
import { approvalsOn } from './approvals';
import type { Plugins } from '../plugins/loader';
import type { ConversationStore } from './conversation-store';
import { printable } from './model-input';
import { toolOutcome } from './tool-outcome';
import { message, needsApproval, type InstalledPlugin } from './types';

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
  /** The installed app tool and whether calling `name` with `input` needs the user's approval. */
  private async resolve(id: string, name: string, input: Record<string, unknown>) {
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
    // A tool the plugin does not expose has no declared effects, so it is treated as risky.
    const target = snapshot.bindings[`${record.provider}__${name}`]?.tool;
    const approval = (await approvalsOn(this.store)) && (!target || needsApproval(target, input));
    return { record, app: tool.app, approval };
  }
  async needsApproval(id: string, name: string, input: Record<string, unknown>) {
    return (await this.resolve(id, name, input)).approval;
  }
  async call(
    id: string,
    name: string,
    input: Record<string, unknown>,
    approved = false,
  ): Promise<unknown> {
    const { record, app, approval } = await this.resolve(id, name, input);
    if (approval && !approved) throw new Error('This action needs your approval.');
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
      const result = await app.call(name, input, AbortSignal.timeout(30000));
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
