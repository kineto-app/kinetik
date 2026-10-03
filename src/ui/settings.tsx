import { createSignal, For, Index, Show } from 'solid-js';
import { rpc } from '../browser/client';
import type { CustomModelState } from '../connections/custom-model';
import type { SetupState } from '../connections/manager';
import type { TraceEntry } from '../core/trace';
import type { InstalledPlugin } from '../core/types';
import type { MemoryChange } from '../core/memory';
import { shortAge } from './time';
import { isNative } from '../platform/environment';
import { icon, type IconName } from './icons';
import './settings.css';

type Plugin = Pick<InstalledPlugin, 'manifest' | 'source' | 'enabledAt'>;
type Page = 'root' | 'connections' | 'service' | 'add' | 'memory';
interface Entry {
  page: Page;
  service?: string;
  from?: HTMLElement;
}
interface Service {
  key: string;
  kind: 'chatgpt' | 'charms' | 'plugin';
  name: string;
  icon: IconName;
  tile: string;
  on: boolean;
  status: string;
  summary: string;
  plugin?: Plugin;
}
export interface SettingsActions {
  /** Opens the guided connection setup. */
  connect(): void;
  enable(id: string, enabled: boolean): Promise<void>;
  update(id: string): Promise<void>;
  disconnect(kind: 'charms' | 'chatgpt'): Promise<void>;
}

const [setup, setSetup] = createSignal<SetupState>();
const [plugins, setPlugins] = createSignal<Plugin[]>([]);
const [stack, setStack] = createSignal<Entry[]>([{ page: 'root' }]);
const [busy, setBusy] = createSignal(false);
let actions: SettingsActions | undefined;
let heading: HTMLHeadingElement | undefined;
let feedback: HTMLParagraphElement | undefined;
export { setSetup as setSettingsSetup, setPlugins as setSettingsPlugins };
/** Chat titles, so Memory can say where Kinetik last changed it. */
const [chatTitles, setChatTitles] = createSignal(new Map<string, string>());
export const setSettingsChats = (chats: { id: string; title: string }[]) =>
  setChatTitles(new Map(chats.map((c) => [c.id, c.title])));
export function setSettingsActions(value: SettingsActions) {
  actions = value;
}

const charmsStatus = {
  connected: 'Connected',
  disabled: 'Off',
  reconnect: 'Reconnect to continue',
  'not-connected': 'Not connected',
} as const;
function services(): Service[] {
  const state = setup();
  const chatgpt = state?.chatgpt;
  const chatgptStatus = chatgpt?.connected
    ? 'Connected'
    : chatgpt?.available
      ? 'Not connected'
      : 'Unavailable on this host';
  const list: Service[] = [
    {
      key: 'chatgpt',
      kind: 'chatgpt',
      name: 'ChatGPT',
      icon: 'spark',
      tile: 'var(--tile-chatgpt)',
      on: Boolean(chatgpt?.connected),
      status: chatgptStatus,
      summary: chatgpt?.connected && chatgpt.model ? `Connected · ${chatgpt.model}` : chatgptStatus,
    },
  ];
  const presetCharms = Boolean(state?.charms.available);
  if (state && presetCharms) {
    const status = charmsStatus[state.charms.status];
    list.push({
      key: 'charms',
      kind: 'charms',
      name: 'Charms',
      icon: 'box',
      tile: 'var(--tile-charms)',
      on: state.charms.status === 'connected',
      status,
      summary: state.charms.status === 'connected' ? 'Connected · cloud workspace' : status,
      plugin: plugins().find((p) => p.manifest.id === 'charms'),
    });
  }
  for (const plugin of plugins()) {
    if (presetCharms && plugin.manifest.id === 'charms') continue;
    const on = plugin.enabledAt !== null;
    list.push({
      key: 'plugin:' + plugin.manifest.id,
      kind: 'plugin',
      name: plugin.manifest.name,
      icon: 'plug',
      tile: 'var(--tile-plugin)',
      on,
      status: on ? 'On' : 'Off',
      summary: `Version ${plugin.manifest.version} · ${on ? 'On' : 'Off'}`,
      plugin,
    });
  }
  return list;
}
function accountLine() {
  const chatgpt = setup()?.chatgpt;
  if (!chatgpt?.available) return 'Preview · AI chat and ChatGPT sign-in aren’t connected yet';
  if (!chatgpt.connected) return 'Not connected · Sign in to chat';
  if (!chatgpt.browser) return 'Signed in · Managed by this host’s sign-in helper';
  return isNative ? 'Signed in · Protected on this device' : 'Signed in · Saved on this device';
}

const titles: Record<Exclude<Page, 'service'>, string> = {
  root: 'Settings',
  connections: 'Connections',
  add: 'Add a connection',
  memory: 'Memory',
};
const top = () => stack().at(-1)!;
const title = (entry: Entry) =>
  entry.page === 'service'
    ? (services().find((s) => s.key === entry.service)?.name ?? 'Connection')
    : titles[entry.page];
const current = () => {
  const entry = top();
  return entry.page === 'service' ? services().find((s) => s.key === entry.service) : undefined;
};
function clearFeedback() {
  if (!feedback) return;
  feedback.textContent = '';
  feedback.dataset.kind = '';
}
function go(page: Page, service?: string) {
  const from = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  setStack([...stack(), { page, service, from }]);
  clearFeedback();
  heading?.focus();
}
function back() {
  const entry = top();
  setStack(stack().slice(0, -1));
  clearFeedback();
  if (entry.from?.isConnected) entry.from.focus();
  else heading?.focus();
}
/** Resets the dialog to a page; the caller opens the dialog. */
export function showSettings(page: 'root' | 'connections' | 'custom' = 'root') {
  setAdvancedOpen(page === 'custom');
  setStack(
    page === 'root'
      ? [{ page: 'root' }]
      : page === 'custom'
        ? [{ page: 'root' }, { page: 'service', service: 'chatgpt' }]
        : [{ page: 'root' }, { page }],
  );
  clearFeedback();
}
/** Replaces the add page with the page of the plugin that was just added. */
export function showAddedPlugin(id: string) {
  const key = services().find((s) => s.plugin?.manifest.id === id)?.key;
  if (!key || top().page !== 'add') return;
  setStack([...stack().slice(0, -1), { page: 'service', service: key }]);
  heading?.focus();
}
async function run(work: () => Promise<void>) {
  if (busy() || !actions) return;
  setBusy(true);
  clearFeedback();
  try {
    await work();
  } catch (error) {
    if (feedback) {
      feedback.textContent = error instanceof Error ? error.message : String(error);
      feedback.dataset.kind = 'error';
    }
  } finally {
    setBusy(false);
  }
}

function Icon(props: { name: IconName }) {
  return <span class="icon-slot" innerHTML={icon(props.name)} />;
}
function Tile(props: { name: IconName; color: string }) {
  return (
    <span class="settings-tile" style={{ background: props.color }}>
      <Icon name={props.name} />
    </span>
  );
}
function Info(props: { label: string; value: string }) {
  return (
    <div class="settings-row">
      <span class="settings-label">{props.label}</span>
      <span class="settings-value">{props.value}</span>
    </div>
  );
}

const traceLine = (entry: TraceEntry) =>
  `${new Date(entry.at).toLocaleTimeString()} ${entry.kind} ${entry.name} ${entry.ok ? 'ok' : 'failed'} ${entry.ms} ms${entry.error ? ' · ' + entry.error : ''}`;

/** Recent model requests and tool calls, read when opened and copied for a bug report. */
function ActivityLog() {
  const [entries, setEntries] = createSignal<TraceEntry[]>([]);
  const [note, setNote] = createSignal('');
  const load = async () => setEntries(await rpc<TraceEntry[]>('trace'));
  const copy = async () => {
    await navigator.clipboard.writeText(entries().map(traceLine).join('\n'));
    setNote('Copied.');
  };
  return (
    <details
      class="settings-advanced"
      onToggle={(event) =>
        event.currentTarget.open && void load().catch(() => setNote('Could not read the log.'))
      }
    >
      <summary>Advanced</summary>
      <div class="settings-group">
        <div class="settings-row">
          <span class="settings-label">Activity log</span>
          <div class="settings-buttons">
            <button
              class="secondary"
              disabled={!entries().length}
              onClick={() => void copy().catch(() => setNote('Copy is not available here.'))}
            >
              Copy
            </button>
          </div>
        </div>
        <Show when={entries().length} fallback={<p class="trace-empty">Nothing recorded yet.</p>}>
          <ol class="trace-list" tabIndex={0} aria-label="Recent model requests and tool calls">
            <For each={entries()}>
              {(entry) => (
                <li classList={{ failed: !entry.ok }}>
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleTimeString()}
                  </time>
                  <span class="trace-name">
                    {entry.kind === 'model' ? 'Model' : 'Tool'} · {entry.name}
                  </span>
                  <span class="trace-ms">{entry.ok ? `${entry.ms} ms` : 'failed'}</span>
                  <Show when={entry.error}>
                    <span class="trace-error">{entry.error}</span>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
      <p class="settings-note" role="status">
        {note() ||
          'The last model requests and tool calls, kept on this device. Export includes them.'}
      </p>
    </details>
  );
}

function ServicePage(props: { service: Service }) {
  const s = () => props.service;
  const charms = () => setup()?.charms.status;
  const connectLabel = () => {
    if (s().kind === 'chatgpt')
      return setup()?.chatgpt.available && !setup()?.chatgpt.connected ? 'Connect ChatGPT' : '';
    if (s().kind === 'charms')
      return charms() === 'not-connected'
        ? 'Connect Charms'
        : charms() === 'reconnect'
          ? 'Reconnect Charms'
          : '';
    return '';
  };
  const canToggle = () =>
    s().kind === 'plugin' ||
    (s().kind === 'charms' && ['connected', 'disabled'].includes(charms() ?? ''));
  const disconnectLabel = () =>
    s().kind === 'chatgpt' && setup()?.chatgpt.connected
      ? 'Sign out'
      : s().kind === 'charms' && ['connected', 'disabled', 'reconnect'].includes(charms() ?? '')
        ? 'Disconnect'
        : '';
  const id = () => s().plugin?.manifest.id ?? '';
  return (
    <>
      <div class="settings-group">
        <div class="settings-row">
          <span class="settings-label">Status</span>
          <span class="settings-value">
            <span class="status-dot" classList={{ off: !s().on }} aria-hidden="true" />
            {s().status}
          </span>
        </div>
        <Show when={s().plugin}>
          {(plugin) => <Info label="Version" value={plugin().manifest.version} />}
        </Show>
        <Show when={s().kind === 'chatgpt' && setup()?.chatgpt.model}>
          {(model) => <Info label="Model" value={model()} />}
        </Show>
      </div>
      <Show when={connectLabel() || s().plugin || canToggle()}>
        <div class="settings-group">
          <Show when={connectLabel()}>
            <button class="settings-row settings-action" onClick={() => actions?.connect()}>
              {connectLabel()}
            </button>
          </Show>
          <Show when={s().plugin}>
            <button
              class="settings-row settings-action"
              disabled={busy()}
              onClick={() => void run(() => actions!.update(id()))}
            >
              Update
            </button>
          </Show>
          <Show when={canToggle()}>
            <button
              class="settings-row settings-action"
              disabled={busy()}
              onClick={() => void run(() => actions!.enable(id() || s().key, !s().on))}
            >
              {s().on ? 'Turn off' : 'Turn on'}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={disconnectLabel()}>
        <div class="settings-group">
          <button
            class="settings-row settings-danger"
            disabled={busy()}
            onClick={() =>
              void run(() => actions!.disconnect(s().kind === 'chatgpt' ? 'chatgpt' : 'charms'))
            }
          >
            {disconnectLabel()}
          </button>
        </div>
      </Show>
      <Show when={s().kind === 'chatgpt' && !setup()?.chatgpt.available}>
        <p class="settings-note">
          You’re trying a preview. The examples save real files on this device. Open-ended AI chat
          and ChatGPT sign-in aren’t connected yet.
        </p>
      </Show>
      <Show when={s().kind === 'chatgpt'}>
        <details
          class="settings-advanced"
          open={advancedOpen()}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>Advanced</summary>
          <CustomModelForm />
        </details>
      </Show>
      <Show when={s().plugin}>
        {(plugin) => (
          <details class="settings-advanced">
            <summary>Advanced</summary>
            <div class="settings-group">
              <div class="settings-row settings-stacked">
                <span class="settings-label">Source</span>
                <span class="settings-value settings-code">{plugin().source}</span>
              </div>
            </div>
          </details>
        )}
      </Show>
    </>
  );
}

const [custom, setCustom] = createSignal<CustomModelState>({ configured: false, chosen: false });
const [advancedOpen, setAdvancedOpen] = createSignal(false);
const [memory, setMemory] = createSignal('');
const [memorySaved, setMemorySaved] = createSignal(false);
const [memoryChange, setMemoryChange] = createSignal<MemoryChange | null>(null);
function changeLine(change: MemoryChange) {
  const chat = change.conversationId && chatTitles().get(change.conversationId);
  const who = change.by === 'kinetik' ? 'Kinetik' : 'you';
  return `Last changed by ${who}${chat ? ` in “${chat}”` : ''} · ${shortAge(change.at)}`;
}
const [notifying, setNotifying] = createSignal(false);
/** Loads the values Settings shows that live in the agent store. */
export async function refreshSettingsData() {
  setCustom(await rpc<CustomModelState>('customModel', { action: 'state' }));
  setMemory(await rpc<string>('memory'));
  setMemoryChange(await rpc<MemoryChange | null>('memoryChange'));
  setNotifying(await rpc<boolean>('notifications'));
}
async function toggleNotifications(enabled: boolean) {
  if (enabled) {
    // Ask for the permission at the moment the user turns the switch on.
    const granted = isNative
      ? (
          await import('@tauri-apps/api/core').then(({ invoke }) =>
            invoke<{ value: string }>('plugin:native|notify', { payload: { active: true } }),
          )
        ).value !== 'denied'
      : 'Notification' in globalThis && (await Notification.requestPermission()) === 'granted';
    if (!granted) {
      setNotifying(false);
      throw new Error('Notifications are blocked. Allow them for Kinetik in your device settings.');
    }
  }
  setNotifying(await rpc<boolean>('notifications', { enabled }));
}

/** An OpenAI-compatible server, kept out of the way under ChatGPT's Advanced section. */
function CustomModelForm() {
  let endpoint!: HTMLInputElement;
  let key!: HTMLInputElement;
  let model!: HTMLInputElement;
  let window!: HTMLInputElement;
  let images!: HTMLInputElement;
  const send = (action: 'save' | 'remove') =>
    void run(async () => {
      setCustom(
        await rpc<CustomModelState>('customModel', {
          action,
          baseUrl: endpoint.value,
          apiKey: key.value,
          model: model.value,
          contextWindow: window.value,
          images: images.checked,
        }),
      );
      key.value = '';
      globalThis.dispatchEvent(new Event('kinetik-custom-model'));
    });
  return (
    <form
      class="custom-model"
      aria-label="Custom model"
      onSubmit={(event) => {
        event.preventDefault();
        send('save');
      }}
    >
      <p class="settings-note">
        Use another model through an OpenAI-compatible endpoint (Chat Completions), such as
        OpenRouter, Ollama, LM Studio or vLLM. Choose it in the composer’s model menu. The key stays
        on this device and is never exported; in a browser, installed connections can read it.
      </p>
      <label for="custom-endpoint">Endpoint</label>
      <input
        id="custom-endpoint"
        ref={endpoint}
        type="url"
        required
        value={custom().baseUrl ?? ''}
        placeholder="https://openrouter.ai/api/v1"
      />
      <label for="custom-model-name">Model</label>
      <input
        id="custom-model-name"
        ref={model}
        required
        spellcheck={false}
        value={custom().model ?? ''}
        placeholder="provider/model-name"
      />
      <label for="custom-key">API key</label>
      <input
        id="custom-key"
        ref={key}
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder={
          custom().hasKey ? 'Saved · type to replace' : 'Optional for servers on this device'
        }
      />
      <label for="custom-window">Context window (tokens)</label>
      <input
        id="custom-window"
        ref={window}
        inputmode="numeric"
        value={custom().contextWindow ?? ''}
        placeholder="128000"
      />
      <label class="custom-check">
        <input ref={images} type="checkbox" checked={custom().images === true} />
        The model can read photos
      </label>
      <div class="form-actions">
        <Show when={custom().configured}>
          <button type="button" class="secondary" onClick={() => send('remove')}>
            Remove
          </button>
        </Show>
        <button class="primary" type="submit">
          Save
        </button>
      </div>
    </form>
  );
}

export function SettingsDialog() {
  const parent = () => stack().at(-2);
  const page = () => top().page;
  return (
    <dialog id="settings-dialog" class="settings-dialog" aria-labelledby="settings-heading">
      <div class="dialog-head settings-head">
        <Show when={parent()}>
          {(entry) => (
            <button class="settings-back" aria-label={`Back to ${title(entry())}`} onClick={back}>
              <Icon name="back" />
              <span>{title(entry())}</span>
            </button>
          )}
        </Show>
        <h2 id="settings-heading" tabindex="-1" ref={heading}>
          {title(top())}
        </h2>
        <button data-close="settings-dialog" class="icon-button" aria-label="Close settings">
          <Icon name="close" />
        </button>
      </div>
      <section class="settings-page" hidden={page() !== 'root'}>
        <div class="settings-group">
          <button class="settings-row settings-account" onClick={() => go('service', 'chatgpt')}>
            <span class="settings-avatar">
              <Icon name="user" />
            </span>
            <span class="settings-text">
              <span class="settings-title">ChatGPT</span>
              <span class="settings-sub">{accountLine()}</span>
            </span>
            <Icon name="chevron" />
          </button>
        </div>
        <div class="settings-group">
          <button
            class="settings-row"
            onClick={() => {
              setMemorySaved(false);
              go('memory');
            }}
          >
            <Tile name="brain" color="var(--tile-memory)" />
            <span class="settings-label">Memory</span>
            <span class="settings-value">{memory().trim() ? 'On' : 'Empty'}</span>
            <Icon name="chevron" />
          </button>
          <label class="settings-row">
            <Tile name="bell" color="var(--tile-notify)" />
            <span class="settings-label">Notify me when work finishes</span>
            <input
              type="checkbox"
              role="switch"
              class="settings-switch"
              checked={notifying()}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                void run(() => toggleNotifications(enabled));
              }}
            />
          </label>
        </div>
        <div class="settings-group">
          <button class="settings-row" onClick={() => go('connections')}>
            <Tile name="plug" color="var(--tile-connections)" />
            <span class="settings-label">Connections</span>
            <span class="settings-value">{services().filter((s) => s.on).length} on</span>
            <Icon name="chevron" />
          </button>
          <div class="settings-row settings-wrap">
            <Tile name="moon" color="var(--tile-appearance)" />
            <span id="appearance-label" class="settings-label">
              Appearance
            </span>
            <div class="segmented" role="radiogroup" aria-labelledby="appearance-label">
              <label>
                <input type="radio" name="appearance" value="light" />
                Light
              </label>
              <label>
                <input type="radio" name="appearance" value="dark" />
                Dark
              </label>
              <label title="Use device setting">
                <input type="radio" name="appearance" value="system" />
                Auto
              </label>
            </div>
          </div>
        </div>
        <div class="settings-group" role="group" aria-labelledby="data-label">
          <div class="settings-row settings-wrap">
            <Tile name="data" color="var(--tile-data)" />
            <span id="data-label" class="settings-label">
              Your data
            </span>
            <div class="settings-buttons">
              <button id="archive-export" class="secondary">
                Export
              </button>
              <button id="archive-import" class="secondary">
                Import
              </button>
            </div>
          </div>
        </div>
        <p class="settings-note">
          Transfer chats, files, and paused routines. Sign-ins and connection settings stay on this
          device.
        </p>
        <input id="archive-file" type="file" accept="application/json,.json" hidden />
        <p id="archive-status" class="field-hint" role="status"></p>
        <ActivityLog />
      </section>
      <section class="settings-page" hidden={page() !== 'connections'}>
        <div class="settings-group">
          <Index each={services()}>
            {(service) => (
              <button class="settings-row" onClick={() => go('service', service().key)}>
                <Tile name={service().icon} color={service().tile} />
                <span class="settings-text">
                  <span class="settings-title">{service().name}</span>
                  <span class="settings-sub">{service().summary}</span>
                </span>
                <span class="status-dot" classList={{ off: !service().on }} aria-hidden="true" />
                <Icon name="chevron" />
              </button>
            )}
          </Index>
        </div>
        <div class="settings-group">
          <button class="settings-row settings-action" onClick={() => go('add')}>
            <Icon name="plus" />
            <span>Add a connection</span>
          </button>
        </div>
      </section>
      <section class="settings-page" hidden={page() !== 'service'}>
        <Show when={current()}>{(service) => <ServicePage service={service()} />}</Show>
      </section>
      <section class="settings-page" hidden={page() !== 'memory'}>
        <p class="settings-note">
          Short notes about you that every chat reads: name, language, brand style, accounts.
          Kinetik saves what it learns here. Change anything, any time.
        </p>
        <label class="sr-only" for="memory-text">
          Memory
        </label>
        <textarea
          id="memory-text"
          class="memory-text"
          maxLength={4000}
          placeholder="For example: I write in Russian. My brand colours are black and coral."
          value={memory()}
          onInput={(event) => {
            setMemory(event.currentTarget.value);
            setMemorySaved(false);
          }}
        />
        <Show when={memoryChange()}>
          {(change) => (
            <p class="field-hint memory-change">
              <span>{changeLine(change())}</span>
              <button
                type="button"
                class="link-button"
                onClick={() =>
                  void run(async () => {
                    setMemory(await rpc<string>('memory', { undo: true }));
                    setMemoryChange(await rpc<MemoryChange | null>('memoryChange'));
                  })
                }
              >
                Undo
              </button>
            </p>
          )}
        </Show>
        <div class="form-actions">
          <span class="field-hint" role="status">
            {memorySaved() ? 'Saved' : ''}
          </span>
          <button
            class="primary"
            type="button"
            onClick={() =>
              void run(async () => {
                setMemory(await rpc<string>('memory', { text: memory() }));
                setMemoryChange(await rpc<MemoryChange | null>('memoryChange'));
                setMemorySaved(true);
              })
            }
          >
            Save
          </button>
        </div>
      </section>
      <section class="settings-page" hidden={page() !== 'add'}>
        <p class="settings-note">
          Only add trusted connections. They can access your files and chats.
        </p>
        <form id="plugin-form">
          <label for="plugin-source">Connection link</label>
          <input
            id="plugin-source"
            type="url"
            required
            placeholder="https://example.org/plugin.json"
            aria-describedby="source-hint"
          />
          <p id="source-hint" class="field-hint">
            Use the link from your service.
          </p>
          <details class="advanced">
            <summary>
              Connection options <span class="muted">Optional</span>
            </summary>
            <label for="plugin-settings">Advanced settings (JSON)</label>
            <textarea id="plugin-settings" spellcheck={false} aria-describedby="settings-hint">
              {'{}'}
            </textarea>
            <p id="settings-hint" class="field-hint">
              Use the configuration supplied with the connection link.
            </p>
          </details>
          <div class="form-actions">
            <button type="button" id="example" class="secondary">
              Use demo connection
            </button>
            <button class="primary" id="install" type="submit">
              Add connection
            </button>
          </div>
        </form>
      </section>
      <p id="plugin-error" class="feedback" role="status" aria-live="polite" ref={feedback}></p>
    </dialog>
  );
}
