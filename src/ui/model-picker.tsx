import { DropdownMenu } from '@kobalte/core/dropdown-menu';
import { createEffect, createSignal, For, Show } from 'solid-js';
import { rpc } from '../browser/client';
import type { ChatGPTModel } from '../connections/chatgpt';
import { icon } from './icons';
import './model-picker.css';

const effortNames: Record<string, string> = { xhigh: 'Extra high' };
const effortName = (effort: string) =>
  effortNames[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

export function ModelPicker(props: {
  enabled: boolean;
  model: string;
  onSelected: () => Promise<void>;
}) {
  const [open, setOpen] = createSignal(false);
  const [models, setModels] = createSignal<ChatGPTModel[]>([]);
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
      const result = await rpc<{ models: ChatGPTModel[]; selected: string; reasoning?: string }>(
        'chatgpt',
        { action: 'models' },
      );
      if (current !== generation) return;
      setModels(result.models);
      setSelected(result.selected);
      setReasoning(result.reasoning);
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
    }
  });
  async function choose(model: string) {
    setSaving(true);
    setError('');
    try {
      await rpc('chatgpt', { action: 'model', model });
      setSelected(model);
      setReasoning(models().find((entry) => entry.slug === model)?.defaultReasoning);
      setOpen(false);
      await props.onSelected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  async function chooseReasoning(effort: string) {
    setSaving(true);
    setError('');
    try {
      await rpc('chatgpt', { action: 'reasoning', effort });
      setReasoning(effort);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  const levels = () => models().find((model) => model.slug === selected())?.reasoning ?? [];
  const name = () =>
    models().find((model) => model.slug === selected())?.name ||
    (selected() === 'gpt-6.1-sol' ? 'GPT-6.1 Sol' : selected()) ||
    'Choose model';
  return (
    <Show when={props.enabled}>
      <div class="model-picker">
        <DropdownMenu
          modal={false}
          open={open()}
          onOpenChange={(value) => {
            setOpen(value);
            if (value) void load();
          }}
          placement="top-start"
          gutter={8}
        >
          <DropdownMenu.Trigger
            class="model-trigger icon-button"
            type="button"
            aria-label={'Choose model, ' + name()}
            title={name() + (reasoning() ? ' · ' + effortName(reasoning()!) + ' reasoning' : '')}
          >
            <span class="icon-slot" innerHTML={icon('spark')} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="model-menu" aria-label="Models">
              <div class="model-menu-label">Model</div>
              <Show when={loading()}>
                <p class="model-menu-note" role="status">
                  Loading models…
                </p>
              </Show>
              <Show when={error()}>
                <p class="model-menu-error" role="alert">
                  {error()}
                </p>
                <DropdownMenu.Item
                  class="model-option"
                  closeOnSelect={false}
                  onSelect={() => void load()}
                >
                  Try again
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.RadioGroup
                value={selected()}
                onChange={(value) => void choose(value)}
                aria-label="Available models"
              >
                <For each={models()}>
                  {(model) => (
                    <DropdownMenu.RadioItem
                      class="model-option"
                      value={model.slug}
                      closeOnSelect={false}
                      disabled={loading() || saving()}
                    >
                      <DropdownMenu.ItemLabel>{model.name}</DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemIndicator>
                        <span class="icon-slot" innerHTML={icon('check')} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )}
                </For>
              </DropdownMenu.RadioGroup>
              <Show when={!loading() && !error() && !models().length}>
                <p class="model-menu-note">No models available.</p>
              </Show>
              <Show when={saving()}>
                <p class="model-menu-note" role="status">
                  Switching model…
                </p>
              </Show>
              <Show when={levels().length}>
                <DropdownMenu.Separator class="model-menu-separator" />
                <div class="model-menu-label">Reasoning</div>
                <DropdownMenu.RadioGroup
                  value={reasoning() ?? ''}
                  onChange={(value) => void chooseReasoning(value)}
                  aria-label="Reasoning levels"
                >
                  <For each={levels()}>
                    {(level) => (
                      <DropdownMenu.RadioItem
                        class="model-option"
                        value={level.effort}
                        closeOnSelect={false}
                        disabled={loading() || saving()}
                      >
                        <span class="model-option-text">
                          <DropdownMenu.ItemLabel>
                            {effortName(level.effort)}
                          </DropdownMenu.ItemLabel>
                          <Show when={level.description}>
                            <DropdownMenu.ItemDescription class="model-option-description">
                              {level.description}
                            </DropdownMenu.ItemDescription>
                          </Show>
                        </span>
                        <DropdownMenu.ItemIndicator>
                          <span class="icon-slot" innerHTML={icon('check')} />
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    )}
                  </For>
                </DropdownMenu.RadioGroup>
              </Show>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
    </Show>
  );
}
