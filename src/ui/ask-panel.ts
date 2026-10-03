import type { Conversation } from '../core/types';
import { byId } from './dom';
import { jsonView } from './json-view';

let askShown = '';
/** The question a paused call is waiting on, answered with buttons. */
export function renderAsk(
  c: Conversation | undefined,
  answer: (conversationId: string, value: string) => Promise<void>,
) {
  const panel = byId('ask');
  const call = c?.turn?.call;
  const ask = c?.status === 'asking' && call?.state === 'awaiting' ? call.ask : undefined;
  const signature = ask ? c!.id + call!.id : '';
  panel.hidden = !ask;
  if (signature === askShown) return;
  askShown = signature;
  if (!ask) return panel.replaceChildren();
  const conversationId = c!.id;
  const button = (label: string, value: string, primary = false) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = primary ? 'primary' : 'secondary';
    node.textContent = label;
    node.onclick = () => {
      for (const other of panel.querySelectorAll('button')) other.disabled = true;
      void answer(conversationId, value);
    };
    return node;
  };
  const title = document.createElement('p');
  title.className = 'ask-question';
  title.textContent = ask.question;
  const actions = document.createElement('div');
  actions.className = 'ask-actions';
  const parts: Node[] = [title];
  if (ask.kind === 'approval') {
    const details = document.createElement('div');
    details.className = 'ask-details';
    details.append(jsonView(call!.input));
    parts.push(details);
    actions.append(button('Decline', 'decline'), button('Approve', 'approve', true));
  } else if (ask.kind === 'choice') {
    actions.classList.add('ask-options');
    actions.append(...ask.options.map((option) => button(option, option)));
  } else {
    const text = document.createElement('p');
    text.className = 'ask-memory';
    text.textContent = ask.text;
    parts.push(text);
    actions.append(button('Not now', 'dismiss'), button('Save to memory', 'save', true));
  }
  panel.replaceChildren(...parts, actions);
  panel
    .querySelector<HTMLElement>('.ask-actions button:last-child')
    ?.focus({ preventScroll: true });
}
