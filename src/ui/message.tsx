import { onCleanup, onMount, Show } from 'solid-js';
import type { Message } from '../core/types';
import { renderMessageContent, copyButton } from './message-content';
import { messageTime, workDuration } from './time';
import { mountApp } from './mcp-app';
import { mountFile } from './files';
import { isInternalActivity } from './activity-data';

/** A message mounts once. Widget adapters retain their iframe through streaming and fullscreen. */
export function MessageBubble(props: {
  item: Message;
  article: HTMLElement;
  conversationId: string;
  resized: () => void;
}) {
  const item = props.item;
  const onlyWidget = isInternalActivity(item) && Boolean(item.app);
  const content =
    item.role === 'assistant' ? renderMessageContent(item.text) : document.createElement('pre');
  content.classList.add('message-content');
  if (item.role !== 'assistant') content.textContent = item.text;
  const disposers: (() => void)[] = [];
  onMount(() => {
    if (!onlyWidget && item.role === 'tool' && item.file)
      disposers.push(mountFile(props.article, item.file, props.resized));
    if (item.app)
      disposers.push(
        mountApp(
          props.article,
          item.app,
          props.conversationId,
          document.querySelector<HTMLElement>('.composer-area')!,
        ),
      );
  });
  onCleanup(() => disposers.forEach((dispose) => dispose()));
  return (
    <Show when={!onlyWidget && item.role !== 'tool'}>
      {item.role === 'assistant' && item.durationMs !== undefined
        ? workDuration(item.durationMs)
        : null}
      <div class="message-label">
        <Show when={item.role === 'assistant'}>
          <img src="./icon.svg" alt="" width="24" height="24" />
        </Show>
        {item.role === 'user'
          ? 'You'
          : item.role === 'assistant'
            ? 'Kinetik'
            : (item.tool ?? 'Workspace notice')}
      </div>
      {content}
      <Show when={item.role === 'assistant'}>
        <div class="message-actions">
          {copyButton(item.text, 'Copy reply')}
          {messageTime(item.createdAt)}
        </div>
      </Show>
      <Show when={item.role === 'user'}>{messageTime(item.createdAt)}</Show>
    </Show>
  );
}
