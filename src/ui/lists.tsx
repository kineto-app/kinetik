import { For } from 'solid-js';
import type { Conversation } from '../core/types';
import { shortAge } from './time';

/** A stable colour per chat, so a conversation is recognisable at a glance. */
const hue = (id: string) => [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);

export function ConversationList(props: {
  conversations: Conversation[];
  selected: string;
  background: (conversation: Conversation) => boolean;
  unread: Set<string>;
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
          <span
            class="conversation-dot"
            classList={{
              working: conversation.status === 'running' && !props.background(conversation),
              unread: props.unread.has(conversation.id),
            }}
            style={{ '--hue': hue(conversation.id) }}
            aria-hidden="true"
          />
          <span
            class="conversation-title"
            classList={{ unread: props.unread.has(conversation.id) }}
          >
            {conversation.title}
          </span>
          <span class="sr-only">{props.unread.has(conversation.id) ? ', new' : ''}</span>
          <time
            class="conversation-time"
            dateTime={new Date(conversation.updatedAt).toISOString()}
            title={new Date(conversation.updatedAt).toLocaleString()}
          >
            {shortAge(conversation.updatedAt)}
          </time>
        </button>
      )}
    </For>
  );
}
