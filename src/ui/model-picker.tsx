import { Popover } from '@kobalte/core/popover';
import { createEffect, createSignal, For, Index, onCleanup, Show } from 'solid-js';
import { rpc } from '../browser/client';
import type { ChatGPTModel, ReasoningLevel } from '../connections/chatgpt';
import type { CustomModelState } from '../core/model-router';
import { icon } from './icons';
import './model-picker.css';

const effortNames: Record<string, string> = { xhigh: 'Extra high' };
const effortName = (effort: string) =>
  effortNames[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

export function ModelPicker(props: {
  enabled: boolean;
  /** ChatGPT is signed in in this browser, so its models are offered too. */
  chatgpt: boolean;
  /** ChatGPT is connected through the host; it is offered as one choice with the host's model. */
  hostChatgpt: boolean;
  model: string;
  onSelected: () => Promise<void>;
}) {
  const [open, setOpen] = createSignal(false);
  let panel: HTMLDivElement | undefined;
  // Phones show the menu as a bottom sheet over a scrim.
  const phone = matchMedia('(max-width: 700px)');
  const [sheet, setSheet] = createSignal(phone.matches);
  const watchPhone = () => setSheet(phone.matches);
  phone.addEventListener('change', watchPhone);
  onCleanup(() => phone.removeEventListener('change', watchPhone));
  const [models, setModels] = createSignal<ChatGPTModel[]>([]);
  const [custom, setCustom] = createSignal<CustomModelState>({
    configured: false,
    chosen: false,
  });
  const [selected, setSelected] = createSignal(props.model);
  const [reasoning, setReasoning] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  let generation = 0;
  async function load() {
    const current = ++generation;
    setLoading(true);
    setError('');
    try {
      const [result, other] = await Promise.all([
        props.chatgpt
          ? rpc<{ models: ChatGPTModel[]; selected: string; reasoning?: string }>('chatgpt', {
              action: 'models',
            })
          : undefined,
        rpc<CustomModelState>('customModel', { action: 'state' }),
      ]);
      if (current !== generation) return;
      setModels(result?.models ?? []);
      if (result) setSelected(result.selected);
      setReasoning(result?.reasoning);
      setCustom(other);
    } catch (e) {
      if (current === generation) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === generation) setLoading(false);
    }
  }
  createEffect(() => {
    setSelected(props.model);
  });
  createEffect(() => {
    if (props.enabled) void load();
    else {
      generation++;
      setOpen(false);
      setModels([]);
      setCustom({ configured: false, chosen: false });
    }
  });
  async function choose(model: string) {
    setSaving(true);
    setError('');
    try {
      await rpc('customModel', { action: 'choose', use: false });
      if (model !== selected()) await rpc('chatgpt', { action: 'model', model });
      setSelected(model);
      setOpen(false);
      await props.onSelected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
    // The connection decides the effective level (GPT-6.1 Sol defaults to medium); read it back.
    await load();
  }
  async function chooseCustom(use: boolean) {
    setSaving(true);
    setError('');
    try {
      setCustom(await rpc<CustomModelState>('customModel', { action: 'choose', use }));
      setOpen(false);
      await props.onSelected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  const choice = () => custom().chosen;
  // Saves run in order, so the last level the user stopped on is the one stored.
  let saves = Promise.resolve();
  function chooseReasoning(effort: string) {
    setError('');
    setReasoning(effort);
    saves = saves
      .then(() => rpc('chatgpt', { action: 'reasoning', effort }))
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        return load();
      });
  }
  const levels = () =>
    choice() ? [] : (models().find((model) => model.slug === selected())?.reasoning ?? []);
  const name = () =>
    (choice() ? custom().model : '') ||
    models().find((model) => model.slug === selected())?.name ||
    (!props.chatgpt && props.hostChatgpt ? 'ChatGPT' : '') ||
    (selected() === 'gpt-6.1-sol' ? 'GPT-6.1 Sol' : selected()) ||
    'Choose model';
  return (
    <Show when={props.enabled}>
      <div class="model-picker">
        <Popover
          modal={false}
          open={open()}
          onOpenChange={(value) => {
            setOpen(value);
            if (value) void load();
          }}
          placement="top-start"
          gutter={8}
        >
          <Popover.Trigger
            class="model-trigger icon-button"
            type="button"
            aria-label={'Choose model, ' + name()}
            title={name() + (reasoning() ? ' · ' + effortName(reasoning()!) + ' reasoning' : '')}
          >
            <span class="icon-slot" innerHTML={icon('spark')} />
          </Popover.Trigger>
          <Popover.Portal>
            <Show when={sheet()}>
              {/* Catches taps outside the sheet so they never reach the chat underneath. */}
              <div
                class="model-scrim"
                aria-hidden="true"
                onPointerDown={(event) => {
                  event.preventDefault();
                  setOpen(false);
                }}
              />
            </Show>
            <Popover.Content
              class="model-menu"
              aria-label="Model and reasoning"
              ref={panel}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                (
                  panel?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
                  panel?.querySelector<HTMLElement>('button, input')
                )?.focus();
              }}
            >
              <div class="model-menu-label" id="model-list-label">
                Model
              </div>
              <Show when={loading()}>
                <p class="model-menu-note" role="status">
                  Loading models…
                </p>
              </Show>
              <Show when={error()}>
                <p class="model-menu-error" role="alert">
                  {error()}
                </p>
                <button type="button" class="model-option" onClick={() => void load()}>
                  Try again
                </button>
              </Show>
              <div class="model-list" role="group" aria-labelledby="model-list-label">
                <Show when={custom().configured && models().length}>
                  <div class="model-group-label">ChatGPT</div>
                </Show>
                {/* Index keeps buttons in place when the list reloads, so focus survives. */}
                <Index each={models()}>
                  {(model) => (
                    <button
                      type="button"
                      class="model-option"
                      aria-pressed={!choice() && model().slug === selected()}
                      disabled={saving()}
                      onClick={() =>
                        (choice() || model().slug !== selected()) && void choose(model().slug)
                      }
                    >
                      {model().name}
                      <Show when={!choice() && model().slug === selected()}>
                        <span class="icon-slot" innerHTML={icon('check')} />
                      </Show>
                    </button>
                  )}
                </Index>
                <Show when={!props.chatgpt && props.hostChatgpt && custom().configured}>
                  <button
                    type="button"
                    class="model-option"
                    aria-pressed={!choice()}
                    disabled={saving()}
                    onClick={() => choice() && void chooseCustom(false)}
                  >
                    ChatGPT
                    <Show when={!choice()}>
                      <span class="icon-slot" innerHTML={icon('check')} />
                    </Show>
                  </button>
                </Show>
                <Show when={custom().configured}>
                  <div class="model-group-label">Custom</div>
                  <button
                    type="button"
                    class="model-option"
                    aria-pressed={choice()}
                    disabled={saving()}
                    onClick={() => !choice() && void chooseCustom(true)}
                  >
                    {custom().model}
                    <Show when={choice()}>
                      <span class="icon-slot" innerHTML={icon('check')} />
                    </Show>
                  </button>
                </Show>
              </div>
              <Show when={!loading() && !error() && !models().length && !custom().configured}>
                <p class="model-menu-note">No models available.</p>
              </Show>
              <Show when={saving()}>
                <p class="model-menu-note" role="status">
                  Saving…
                </p>
              </Show>
              <Show when={levels().length > 1}>
                <hr class="model-menu-separator" />
                <ReasoningSlider levels={levels()} value={reasoning()} onChange={chooseReasoning} />
              </Show>
            </Popover.Content>
          </Popover.Portal>
        </Popover>
      </div>
    </Show>
  );
}

/** Faster ↔ Smarter. A native range input keeps drag, tap, keys and screen readers; the pill is drawn under it. */
function ReasoningSlider(props: {
  levels: ReasoningLevel[];
  value?: string;
  onChange: (effort: string) => void;
}) {
  const committed = () =>
    Math.max(
      0,
      props.levels.findIndex((level) => level.effort === props.value),
    );
  const [index, setIndex] = createSignal(committed());
  createEffect(() => setIndex(committed()));
  const level = () => props.levels[index()];
  const commit = (value: number) => {
    const next = props.levels[value];
    if (next.effort !== props.value) props.onChange(next.effort);
  };
  // Taps and drags are handled here so every platform jumps to the touched stop.
  let dragging = false;
  // Each level owns an equal segment; touching a segment selects it.
  const indexAt = (event: PointerEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const segment = Math.floor(((event.clientX - box.left) / box.width) * props.levels.length);
    return Math.min(props.levels.length - 1, Math.max(0, segment));
  };
  const fill = () => (index() + 1) / props.levels.length;
  return (
    <div class="reasoning" role="group" aria-label="Reasoning">
      <div class="model-menu-label">Reasoning</div>
      <div
        class="reasoning-slider"
        classList={{ 'is-short': fill() < 0.5 }}
        style={{ '--fill': fill() }}
        onPointerDown={(event) => {
          dragging = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.querySelector('input')?.focus({ preventScroll: true });
          setIndex(indexAt(event));
        }}
        onPointerMove={(event) => dragging && setIndex(indexAt(event))}
        onPointerUp={() => {
          if (!dragging) return;
          dragging = false;
          commit(index());
        }}
        onPointerCancel={() => {
          dragging = false;
          setIndex(committed());
        }}
      >
        <div class="reasoning-glow">
          <div class="reasoning-fill" />
        </div>
        <div class="reasoning-ticks" aria-hidden="true">
          <For each={props.levels.slice(1)}>{() => <i />}</For>
        </div>
        <span class="reasoning-name" aria-hidden="true">
          {effortName(level().effort)}
        </span>
        <span class="reasoning-knob" aria-hidden="true" />
        <input
          type="range"
          min="0"
          max={props.levels.length - 1}
          step="1"
          value={index()}
          aria-label="Reasoning level"
          aria-valuetext={effortName(level().effort)}
          onInput={(event) => setIndex(Number(event.currentTarget.value))}
          onChange={(event) => commit(Number(event.currentTarget.value))}
        />
      </div>
      <div class="reasoning-ends" aria-hidden="true">
        <span>
          <span class="icon-slot" innerHTML={icon('bolt')} />
          Faster
        </span>
        <span>
          Smarter
          <span class="icon-slot" innerHTML={icon('brain')} />
        </span>
      </div>
      <Show when={level().description}>
        <p class="reasoning-description">{level().description}</p>
      </Show>
    </div>
  );
}
