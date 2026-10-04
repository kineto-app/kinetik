import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { Message } from '../core/types';
import { renderMessageContent, copyButton } from './message-content';
import { messageTime, tokenCount } from './time';
import { icon } from './icons';
import { mountApp } from './mcp-app';
import { mountFile } from './files';
import { attachmentCarousel } from './attachments';
import { isInternalActivity } from './activity-data';
import { plainNotice } from './notice';

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
  if (item.compaction) {
    props.article.classList.add('compaction-note');
    return (
      <p
        title={`${item.text} ${item.compaction.items} earlier items, about ${tokenCount(item.compaction.tokens)} tokens.`}
      >
        <span class="icon-slot" innerHTML={icon('refresh')} />
        <span>
          {item.text.startsWith('ChatGPT summarised')
            ? 'Earlier messages summarised by ChatGPT'
            : 'Earlier messages summarised'}
        </span>
      </p>
    );
  }
  // Finished background work shows as a step of its run, not as a notice.
  if (item.id.startsWith('background-completed:')) return null;
  if (item.role === 'notice' && item.text === 'Stopped.') {
    props.article.classList.add('compaction-note');
    return (
      <p>
        <span class="icon-slot" innerHTML={icon('stop')} />
        <span>Stopped</span>
      </p>
    );
  }
  if (item.role === 'notice') {
    const notice = plainNotice(item.text);
    const [open, setOpen] = createSignal(false);
    const detailId = 'notice-detail-' + item.id;
    props.article.toggleAttribute('data-failed', notice.failed);
    // One quiet line like "Stopped"; the original text opens under it.
    return (
      <>
        <div class="notice-line">
          <span class="icon-slot notice-mark" innerHTML={icon('info')} />
          <Show when={notice.detail} fallback={<span class="notice-title">{notice.title}</span>}>
            <button
              class="notice-title"
              aria-expanded={open()}
              aria-controls={detailId}
              onClick={() => setOpen(!open())}
            >
              {notice.title}
              <span class="icon-slot notice-chevron" innerHTML={icon('chevron')} />
            </button>
          </Show>
          <Show when={notice.failed}>
            <button
              class="notice-retry"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('kinetik-retry', { detail: props.conversationId }),
                )
              }
            >
              Try again
            </button>
          </Show>
        </div>
        <Show when={notice.detail}>
          <p class="notice-detail" id={detailId} hidden={!open()}>
            {notice.detail}
          </p>
        </Show>
      </>
    );
  }
  return (
    <Show when={!onlyWidget && item.role !== 'tool'}>
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
      <Show when={item.attachments?.length}>{attachmentCarousel(item.attachments!)}</Show>
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
