import type { Store } from '../browser/store';

/** Stored under the `connection-token:` prefix: kept out of exports, and in secure storage on devices. */
export const customModelKey = 'connection-token:custom-model';
export type CustomModel = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow?: number;
  images?: boolean;
};

export type CustomModelState = {
  configured: boolean;
  chosen: boolean;
  baseUrl?: string;
  model?: string;
  contextWindow?: number;
  images?: boolean;
  hasKey?: boolean;
};

export async function customModelState(store: Store): Promise<CustomModelState> {
  const config = await store.get<CustomModel | null>(customModelKey);
  return {
    configured: Boolean(config),
    chosen: (await store.get<string>('model-choice')) === 'custom',
    ...(config
      ? {
          baseUrl: config.baseUrl,
          model: config.model,
          contextWindow: config.contextWindow,
          images: config.images,
          hasKey: Boolean(config.apiKey),
        }
      : {}),
  };
}

/** Validates and applies one Settings or model-picker action on the custom model. */
export async function customModelAction(store: Store, data: Record<string, unknown>) {
  switch (data.action) {
    case 'state':
      break;
    case 'save': {
      const url = new URL(String(data.baseUrl ?? '').trim());
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        throw new Error('The endpoint must use HTTPS, or HTTP on this device.');
      if (url.username || url.password || url.search || url.hash)
        throw new Error('The endpoint must be a plain address.');
      const model = String(data.model ?? '').trim();
      if (!/^[\w.:/@+-]{1,200}$/.test(model)) throw new Error('Enter the model name.');
      const typed = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
      if (typed && !/^[\x21-\x7e]{1,400}$/.test(typed)) throw new Error('Enter a valid API key.');
      const window = data.contextWindow ? Number(data.contextWindow) : undefined;
      if (
        window !== undefined &&
        !(Number.isInteger(window) && window >= 1000 && window <= 10_000_000)
      )
        throw new Error('The context window is a number of tokens, from 1000.');
      const previous = await store.get<CustomModel | null>(customModelKey);
      // A blank key keeps the saved one; servers on this device often need none.
      const apiKey = typed || (data.clearKey ? undefined : previous?.apiKey);
      await store.put<CustomModel>(customModelKey, {
        baseUrl: url.href.replace(/\/$/, ''),
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(window ? { contextWindow: window } : {}),
        ...(data.images === true ? { images: true } : {}),
      });
      break;
    }
    case 'remove':
      // A null write, not a delete, so device secure storage is cleared too.
      await store.put(customModelKey, null);
      if ((await store.get<string>('model-choice')) === 'custom')
        await store.delete('model-choice');
      break;
    case 'choose':
      if (data.use === true) {
        if (!(await store.get<CustomModel | null>(customModelKey)))
          throw new Error('Set up the custom model in Settings → ChatGPT → Advanced first.');
        await store.put('model-choice', 'custom');
      } else await store.delete('model-choice');
      break;
    default:
      throw new Error('Unknown custom model action.');
  }
  return customModelState(store);
}
