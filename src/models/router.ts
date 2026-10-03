import type { Store } from '../core/ports';
import type { Model, ModelRequest, ModelStep, TurnPin } from '../core/types';

type Settings = () => Promise<{ model?: string; effort?: string }>;

/** Sends a turn to ChatGPT or, when the user chose it, to the custom OpenAI-compatible model. */
export class ModelRouter implements Model {
  constructor(
    private store: Store,
    private chatgpt: Model,
    private custom: Model,
    private chatgptSettings: Settings = async () => ({}),
    private customSettings: Settings = async () => ({}),
  ) {}
  async pin(): Promise<TurnPin> {
    const provider =
      (await this.store.get<string>('model-choice')) === 'custom' ? 'custom' : 'chatgpt';
    const settings = await (provider === 'custom' ? this.customSettings : this.chatgptSettings)();
    return { provider, ...settings };
  }
  async compact(input: Record<string, unknown>[], pin: TurnPin | undefined, signal: AbortSignal) {
    // ChatGPT's compaction items are opaque to every other model.
    if (pin?.provider === 'custom') return undefined;
    return this.chatgpt.compact?.(input, pin, signal);
  }
  next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    return request.pin?.provider === 'custom'
      ? this.custom.next(request, signal)
      : this.chatgpt.next(request, signal);
  }
}
