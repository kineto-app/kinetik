import { For, Show } from 'solid-js';
import type { Conversation, InstalledPlugin } from '../core/types';
import { icon } from './icons';

export function ConversationList(props: {
  conversations: Conversation[];
  selected: string;
  background: (conversation: Conversation) => boolean;
  choose: (id: string) => void;
}) {
  return (
    <For each={props.conversations} fallback={<p class="history-empty">No chats yet.</p>}>
      {(conversation) => (
        <button
          class="conversation"
          aria-current={conversation.id === props.selected ? 'true' : 'false'}
          onClick={() => props.choose(conversation.id)}
        >
          {conversation.status === 'running' && !props.background(conversation) ? '• ' : ''}
          {conversation.title}
        </button>
      )}
    </For>
  );
}

export function PluginList(props: {
  plugins: Pick<InstalledPlugin, 'manifest' | 'enabledAt'>[];
  enable: (id: string, enabled: boolean) => Promise<void>;
  update: (id: string) => Promise<void>;
  error: (error: unknown) => void;
}) {
  return (
    <Show
      when={props.plugins.length}
      fallback={
        <div class="plugins-empty">
          <span class="icon-slot" innerHTML={icon('plug')} />
          <div>
            <strong>No connections yet</strong>
          </div>
        </div>
      }
    >
      <For each={props.plugins}>
        {(plugin) => (
          <div class="plugin-row">
            <strong>{plugin.manifest.name}</strong>
            <p class="small muted">
              {plugin.manifest.version} · {plugin.enabledAt === null ? 'Off' : 'On'}
            </p>
            <div class="plugin-actions">
              <button
                class="secondary"
                onClick={() =>
                  void props
                    .enable(plugin.manifest.id, plugin.enabledAt === null)
                    .catch(props.error)
                }
              >
                {plugin.enabledAt === null ? 'Enable' : 'Disable'}
              </button>
              <button onClick={() => void props.update(plugin.manifest.id).catch(props.error)}>
                Update
              </button>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}
