import MarkdownIt from 'markdown-it';
import { icon } from './icons';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
// Replies cannot load tracking images or embed arbitrary HTML. Links require a user click.
markdown.disable('image');

export function copyButton(text: string, label: string, iconOnly = false) {
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'copy-action';
  action.setAttribute('aria-label', label);
  action.title = label;
  action.innerHTML = icon('copy') + (iconOnly || label === 'Copy reply' ? '' : '<span>Copy</span>');
  action.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      action.innerHTML =
        icon('check') + (iconOnly || label === 'Copy reply' ? '' : '<span>Copied</span>');
      const announcement = document.getElementById('ui-announcement');
      if (announcement)
        announcement.textContent = `${label === 'Copy reply' ? 'Reply' : label === 'Copy file' ? 'File' : 'Code'} copied to clipboard.`;
      setTimeout(() => {
        action.innerHTML =
          icon('copy') + (iconOnly || label === 'Copy reply' ? '' : '<span>Copy</span>');
      }, 1800);
    } catch {
      const announcement = document.getElementById('ui-announcement');
      if (announcement)
        announcement.textContent = 'Copy was unavailable. Select the text and copy it manually.';
    }
  };
  return action;
}

export function renderMessageContent(text: string) {
  const content = document.createElement('div');
  content.className = 'message-content markdown';
  // markdown-it escapes raw HTML and rejects unsafe link protocols.
  content.innerHTML = markdown.render(text);
  for (const link of content.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  for (const pre of content.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const frame = document.createElement('div');
    frame.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    const label = document.createElement('span');
    label.textContent = code?.className.replace('language-', '') || 'Text';
    header.append(label, copyButton(code?.textContent ?? pre.textContent ?? '', 'Copy code'));
    pre.replaceWith(frame);
    frame.append(header, pre);
  }
  for (const table of content.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Table');
    table.replaceWith(scroll);
    scroll.append(table);
  }
  return content;
}
