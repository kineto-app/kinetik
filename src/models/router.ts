import { ModelFailure } from '../core/connection-error';
import type { Store } from '../core/ports';
import type { Model, ModelRequest, ModelStep, TurnPin } from '../core/types';

/** One way to reach a model: ChatGPT, the custom OpenAI-compatible endpoint, or another one. */
export interface ModelProvider {
  /** Kept as the user's choice and in each turn's pin. */
  readonly id: string;
  readonly model: Model;
  /** The model and reasoning level a new turn keeps. */
  settings(): Promise<{ model?: string; effort?: string }>;
  /** Whether a new turn can use it now. Only asked when there is more than one to choose from. */
  usable?(): Promise<boolean>;
}

/**
 * Sends each turn to the provider it was pinned to. A new turn uses the custom model when the
 * user chose it, a chosen other provider while it can be used, and otherwise ChatGPT.
 */
export class ModelRouter implements Model {
  constructor(
    private store: Store,
    private chatgpt: ModelProvider,
    private custom: ModelProvider,
    private others: () => Promise<ModelProvider[]> = async () => [],
  ) {}
  /** The provider a new turn uses. */
  async choice(): Promise<ModelProvider> {
    const chosen = await this.store.get<string>('model-choice');
    if (chosen === this.custom.id) return this.custom;
    const others = await this.others();
    if (!others.length || chosen === this.chatgpt.id) return this.chatgpt;
    const other = others.find((provider) => provider.id === chosen);
    if (other && (await usable(other))) return other;
    // ChatGPT once signed in; when nothing can be used, ChatGPT asks the user to sign in.
    if (await usable(this.chatgpt)) return this.chatgpt;
    for (const provider of others) if (await usable(provider)) return provider;
    return this.chatgpt;
  }
  async pin(): Promise<TurnPin> {
    const provider = await this.choice();
    return { provider: provider.id, ...(await provider.settings()) };
  }
  private async pinned(pin: TurnPin | undefined): Promise<ModelProvider> {
    if (!pin || pin.provider === this.chatgpt.id) return this.chatgpt;
    if (pin.provider === this.custom.id) return this.custom;
    const provider = (await this.others()).find((other) => other.id === pin.provider);
    if (!provider)
      throw new ModelFailure('This chat’s model is no longer available. Choose another.');
    return provider;
  }
  async compact(input: Record<string, unknown>[], pin: TurnPin | undefined, signal: AbortSignal) {
    // Only ChatGPT compacts on its side; its items are opaque to every other model.
    const provider = await this.pinned(pin);
    return provider === this.chatgpt ? this.chatgpt.model.compact?.(input, pin, signal) : undefined;
  }
  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    return (await this.pinned(request.pin)).model.next(request, signal);
  }
}

const usable = (provider: ModelProvider) => provider.usable?.() ?? Promise.resolve(true);

/** A provider from a model and the settings its turns keep. */
export const provider = (
  id: string,
  model: Model,
  settings: ModelProvider['settings'] = async () => ({}),
): ModelProvider => ({ id, model, settings });
