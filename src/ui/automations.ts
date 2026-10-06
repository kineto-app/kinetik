import type { Automation } from '../core/automation';
import { rpc } from '../browser/client';
import { icon } from './icons';
export const automationDialog = `
<dialog id="automations-dialog" aria-labelledby="automations-heading">
  <div class="dialog-head"><span class="glyph">${icon('clock')}</span><div><h2 id="automations-heading">Routines</h2></div><button data-close="automations-dialog" class="icon-button" aria-label="Close routines">${icon('close')}</button></div>
  <p id="automation-hint" class="field-hint">Keep Kinetik open. Paused routines catch up once when you return.</p>
  <section class="panel"><h3 class="section-label">Scheduled work</h3><div id="automation-list" class="section-body"></div></section>
  <section class="panel"><h3 class="section-label">Create</h3><form id="automation-form" class="section-body">
    <label for="automation-kind">Routine type</label><select id="automation-kind"><option value="task">One-time task</option><option value="goal">Goal</option><option value="job">Scheduled task</option><option value="monitor">Watch a file</option></select>
    <label for="automation-prompt">What would you like done?</label><textarea id="automation-prompt" required maxlength="12000" rows="3"></textarea>
    <div data-kinds="job monitor"><label for="automation-interval">Repeat every (minutes)</label><input id="automation-interval" type="number" min="1" placeholder="For example, 60" /></div>
    <div data-kinds="monitor"><label for="automation-path">File to watch</label><input id="automation-path" placeholder="/workspace/report.txt" /></div><div data-kinds="job"><label for="automation-event">Or use a custom event (advanced)</label><input id="automation-event" pattern="[\\w.\\-]+" placeholder="For example, file.changed" /></div>
    <div data-kinds="goal job monitor"><label for="automation-limit">Stop after this many runs</label><input id="automation-limit" type="number" min="1" max="1000" value="10" required /></div>
    <button class="primary" type="submit">Create routine</button>
  </form></section>
  <details class="advanced"><summary>Send a test event</summary><form id="event-form" class="section-body"><label for="event-name">Event name</label><input id="event-name" required pattern="[\\w.\\-]+" /><label for="event-text">Event details</label><textarea id="event-text" maxlength="12000"></textarea><button class="secondary">Send event</button></form></details>
  <details class="advanced"><summary>External wake events</summary><p class="field-hint">Your push sender needs this browser's subscription. Browsers may delay or suppress wakeups.</p><label for="push-key">Push sender's public VAPID key</label><input id="push-key" /><button id="push-enable" class="secondary" type="button">Enable and download subscription</button></details>
  <p id="automation-feedback" class="feedback" role="status"></p>
</dialog>`;
export function setupAutomations(refresh: () => Promise<void>) {
  const updateFields = () => {
    const kind = (document.getElementById('automation-kind') as HTMLSelectElement).value;
    for (const group of document.querySelectorAll<HTMLElement>('[data-kinds]')) {
      group.hidden = !group.dataset.kinds!.split(' ').includes(kind);
      for (const input of group.querySelectorAll<HTMLInputElement>('input'))
        input.disabled = group.hidden;
    }
  };
  document.getElementById('automation-kind')!.addEventListener('change', updateFields);
  updateFields();
  document.getElementById('push-enable')!.onclick = () => {
    void (async () => {
      if (!('PushManager' in window))
        throw new Error('Push notifications are not supported by this browser.');
      const key = (document.getElementById('push-key') as HTMLInputElement).value
        .trim()
        .replaceAll('-', '+')
        .replaceAll('_', '/');
      if (!key) throw new Error('Enter your push sender’s public VAPID key.');
      const bytes = Uint8Array.from(atob(key), (value) => value.charCodeAt(0));
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(subscription.toJSON(), null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'kinetik-push-subscription.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      document.getElementById('automation-feedback')!.textContent =
        'Subscription downloaded. Configure it in your push sender.';
    })().catch((error) => {
      document.getElementById('automation-feedback')!.textContent = String(error);
    });
  };
  const field = (id: string) =>
    (document.getElementById(id) as HTMLInputElement).disabled
      ? ''
      : (document.getElementById(id) as HTMLInputElement).value;
  for (const [id, action] of [
    [
      'automation-form',
      () =>
        rpc('automationCreate', {
          input: {
            kind: field('automation-kind'),
            prompt: field('automation-prompt'),
            intervalMs: field('automation-interval')
              ? Number(field('automation-interval')) * 60000
              : undefined,
            event: field('automation-event'),
            watchPath: field('automation-path'),
            maxRuns: field('automation-kind') === 'task' ? 1 : Number(field('automation-limit')),
          },
        }),
    ],
    ['event-form', () => rpc('event', { name: field('event-name'), text: field('event-text') })],
  ] as const) {
    document.getElementById(id)!.onsubmit = (event) => {
      event.preventDefault();
      const submit = document.querySelector<HTMLButtonElement>(`#${id} button`)!;
      submit.disabled = true;
      void action()
        .then(refresh)
        .then(() => {
          document.getElementById('automation-feedback')!.textContent =
            'Saved. Results will appear in your chats.';
        })
        .catch((error) => {
          document.getElementById('automation-feedback')!.textContent = String(error);
        })
        .finally(() => {
          submit.disabled = false;
        });
    };
  }
}
export function renderAutomations(
  items: Automation[],
  refresh: () => Promise<void>,
  choose: (id: string) => void,
) {
  const list = document.getElementById('automation-list')!;
  list.replaceChildren();
  if (!items.length) list.textContent = 'No routines yet.';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const title = document.createElement('strong');
    title.textContent = item.prompt.slice(0, 100);
    const detail = document.createElement('p');
    detail.className = 'field-hint';
    detail.textContent = `${{ task: 'One-time task', goal: 'Goal', job: 'Scheduled task', monitor: 'Watch a file' }[item.kind]} · ${item.status} · ${item.runs}/${item.maxRuns} runs${item.lastError ? ' · ' + item.lastError : ''}`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (item.status !== 'completed') {
      const toggle = document.createElement('button');
      toggle.className = 'secondary';
      toggle.textContent = item.status === 'active' ? 'Pause' : 'Resume';
      toggle.onclick = () => {
        void rpc('automationStatus', {
          id: item.id,
          status: item.status === 'active' ? 'paused' : 'active',
        })
          .then(refresh)
          .catch((error) => {
            document.getElementById('automation-feedback')!.textContent = String(error);
          });
      };
      actions.append(toggle);
    }
    if (item.conversationId ?? item.lastConversationId) {
      const open = document.createElement('button');
      open.textContent = 'Open chat';
      open.onclick = () => {
        (document.getElementById('automations-dialog') as HTMLDialogElement).close();
        choose((item.conversationId ?? item.lastConversationId)!);
      };
      actions.append(open);
    }
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.onclick = () => {
      void rpc('automationRemove', { id: item.id })
        .then(refresh)
        .catch((error) => {
          document.getElementById('automation-feedback')!.textContent = String(error);
        });
    };
    actions.append(remove);
    row.append(title, detail, actions);
    list.append(row);
  }
}
