import type { Store } from '../browser/store';
import {
  isProvider,
  providerKey,
  providerModels,
  providerNames,
  type ProviderCredential,
  type ProviderId,
} from './pi-model';
import type { Model, ModelRequest, ModelStep } from './types';

/** Sends a turn to ChatGPT or, when the user chose one, to Claude or Gemini. */
export class ModelRouter implements Model {
  constructor(
    private store: Store,
    private chatgpt: Model,
    private other: Model,
  ) {}
  /** `provider:model` for a chosen Claude or Gemini model; undefined means ChatGPT. */
  pin(): Promise<string | undefined> {
    return this.store.get<string>('model-choice');
  }
  next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    return isProvider(request.pin?.split(':')[0])
      ? this.other.next(request, signal)
      : this.chatgpt.next(request, signal);
  }
}

export type ProvidersState = {
  providers: {
    id: ProviderId;
    name: string;
    connected: boolean;
    baseUrl?: string;
    models: { id: string; name: string }[];
  }[];
  choice?: string;
};

export async function providersState(store: Store): Promise<ProvidersState> {
  const providers = await Promise.all(
    (Object.keys(providerNames) as ProviderId[]).map(async (id) => {
      const credential = await store.get<ProviderCredential | null>(providerKey(id));
      return {
        id,
        name: providerNames[id],
        connected: Boolean(credential?.apiKey),
        baseUrl: credential?.baseUrl,
        models: providerModels[id],
      };
    }),
  );
  return { providers, choice: await store.get<string>('model-choice') };
}

/** Validates and applies one Settings or model-picker action on provider keys and the model choice. */
export async function providersAction(store: Store, data: Record<string, unknown>) {
  const provider = data.provider;
  switch (data.action) {
    case 'state':
      break;
    case 'save': {
      if (!isProvider(provider)) throw new Error('Unknown provider.');
      const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
      if (!/^[\x21-\x7e]{8,400}$/.test(apiKey)) throw new Error('Enter a valid API key.');
      let baseUrl: string | undefined;
      if (typeof data.baseUrl === 'string' && data.baseUrl.trim()) {
        const url = new URL(data.baseUrl.trim());
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
          throw new Error('The endpoint must use HTTPS.');
        if (url.username || url.password || url.search || url.hash)
          throw new Error('The endpoint must be a plain address.');
        baseUrl = url.href.replace(/\/$/, '');
      }
      await store.put(providerKey(provider), { apiKey, ...(baseUrl ? { baseUrl } : {}) });
      break;
    }
    case 'remove':
      if (!isProvider(provider)) throw new Error('Unknown provider.');
      // A null write, not a delete, so device secure storage is cleared too.
      await store.put(providerKey(provider), null);
      if ((await store.get<string>('model-choice'))?.startsWith(provider + ':'))
        await store.delete('model-choice');
      break;
    case 'choose':
      if (provider === 'chatgpt') {
        await store.delete('model-choice');
        break;
      }
      if (!isProvider(provider)) throw new Error('Unknown provider.');
      if (!providerModels[provider].some((model) => model.id === data.model))
        throw new Error('That model is not available.');
      if (!(await store.get<ProviderCredential | null>(providerKey(provider)))?.apiKey)
        throw new Error(`Add your ${providerNames[provider]} API key in Settings → Models first.`);
      await store.put('model-choice', `${provider}:${data.model}`);
      break;
    default:
      throw new Error('Unknown models action.');
  }
  return providersState(store);
}
