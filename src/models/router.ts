import type { Store } from '../browser/store';
import type { Model, ModelRequest, ModelStep } from '../core/types';

/** Sends a turn to ChatGPT or, when the user chose it, to the custom OpenAI-compatible model. */
export class ModelRouter implements Model {
  constructor(
    private store: Store,
    private chatgpt: Model,
    private custom: Model,
  ) {}
  /** `custom` when the custom model is chosen; undefined means ChatGPT. */
  pin(): Promise<string | undefined> {
    return this.store.get<string>('model-choice');
  }
  async compact(input: Record<string, unknown>[], pin: string | undefined, signal: AbortSignal) {
    // ChatGPT's compaction items are opaque to every other model.
    if (pin === 'custom') return undefined;
    return this.chatgpt.compact?.(input, pin, signal);
  }
  next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    return request.pin === 'custom'
      ? this.custom.next(request, signal)
      : this.chatgpt.next(request, signal);
  }
}
