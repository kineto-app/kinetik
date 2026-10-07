import {
  ConnectionError,
  ConsentRequired,
  ModelFailure,
  OutOfCredits,
  RateLimited,
  SignInRequired,
} from '../core/connection-error';
import type { Store } from '../core/ports';
import type { ModelProviderDeclaration } from '../core/types';
import { CompatModel } from './compat';
import { httpFailure } from './model-http';
import type { ModelProvider } from './router';

/** One model the server lists. No reasoning level is offered for these. */
export interface ServedModel {
  id: string;
  name: string;
  /** Reads photos; without it they are replaced by a note. */
  images?: boolean;
  /** Input tokens it takes, for summarising in time; 128k when the server does not say. */
  contextWindow?: number;
}
interface ModelList {
  models: ServedModel[];
  checkedAt: number;
  /** Asked with a token; a list from before sign-in is asked for again once signed in. */
  signedIn?: boolean;
}

/** A plugin's sign-in connection, as far as its models need it. */
export interface ModelConnection {
  /** The plugin's id, which is also the provider's. */
  id: string;
  declaration: ModelProviderDeclaration;
  /** The connection's address; the models are on its origin. */
  url: string;
  /** The connection's token while it is signed in and turned on. */
  token(): Promise<string | undefined>;
  /** Marks a token the server rejected, so the connection asks to sign in again. */
  rejected(token: string): Promise<void>;
}

/** How long a model list is trusted before it is asked for again. */
const listAge = 10 * 60 * 1000;
const modelId = /^[\w.:/@+-]{1,100}$/;

/**
 * The models a plugin's connection serves. The server's list decides what is offered; an empty
 * list switches them off. Turns go through the Chat Completions client with the connection's token.
 */
export class ConnectionModels implements ModelProvider {
  readonly model: CompatModel;
  private refreshing?: Promise<ServedModel[]>;
  private forcing?: Promise<ServedModel[]>;
  constructor(
    private store: Store,
    private connection: ModelConnection,
    private request: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.model = new CompatModel(
      async (pin) => {
        const token = await connection.token();
        if (!token) throw new SignInRequired(this.signIn());
        // Every way a turn starts (a message, a routine, Try again) passes here.
        if (!(await this.consented()))
          throw new ConsentRequired(`Agree to where messages to ${this.name} go to continue.`);
        const model =
          (await this.list()).find((served) => served.id === pin?.model) ?? (await this.chosen());
        return {
          baseUrl: this.base,
          apiKey: token,
          model: model?.id ?? pin?.model ?? '',
          images: model?.images,
          contextWindow: model?.contextWindow,
        };
      },
      (input, init) => this.request(input, init),
      {
        name: this.name,
        setUp: this.signIn(),
        failure: (response, config) => this.failure(response, config.apiKey ?? ''),
        streamError: (code, message, config) => this.streamError(code, message, config.apiKey),
      },
    );
  }
  get id() {
    return this.connection.id;
  }
  get name() {
    return this.connection.declaration.name;
  }
  /** The declared path on the connection's origin, never another host. */
  get base() {
    return new URL(this.connection.declaration.path, new URL(this.connection.url).origin).href;
  }
  private get key() {
    return 'connection-models:' + this.id;
  }
  private signIn() {
    return `Sign in again to keep using ${this.name}.`;
  }
  /** The last list the server gave, kept on the device. */
  async list(): Promise<ServedModel[]> {
    return (await this.store.get<ModelList>(this.key))?.models ?? [];
  }
  /**
   * The list without waiting on the network once one was ever asked for: a slow server delays
   * nothing, and the answer counts from the next call. Only the first time waits for it.
   */
  async current(): Promise<ServedModel[]> {
    if (!(await this.store.get<ModelList>(this.key))) return this.refresh();
    void this.refresh().catch(() => {});
    return this.list();
  }
  /**
   * Asks the server for its list at most every few minutes, whatever it answers. `force` asks
   * now, but only once signed in, so nothing is asked again and again before sign-in.
   */
  refresh(force = false): Promise<ServedModel[]> {
    if (!force)
      return (this.refreshing ??= this.fetchList(false).finally(() => {
        this.refreshing = undefined;
      }));
    // Asked to ask now: after any check already running, which may have answered from the list.
    return (this.forcing ??= (this.refreshing ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.fetchList(true))
      .finally(() => {
        this.forcing = undefined;
      }));
  }
  private async fetchList(force: boolean): Promise<ServedModel[]> {
    const saved = await this.store.get<ModelList>(this.key);
    const token = await this.connection.token();
    if (
      saved &&
      Boolean(saved.signedIn) === Boolean(token) &&
      (!force || !token) &&
      Date.now() - saved.checkedAt < listAge
    )
      return saved.models;
    // An answer that says nothing (offline, signed out, not offered here) keeps the last list.
    const keep = async () => {
      const models = saved?.models ?? [];
      await this.store.put<ModelList>(this.key, {
        models,
        checkedAt: Date.now(),
        signedIn: Boolean(token),
      });
      return models;
    };
    let response: Response;
    try {
      // Before sign-in the server may still say whether it offers models.
      response = await this.request(this.base + '/models', {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return keep();
    }
    // A rejected token here never signs the user out: only a chat request does that.
    if ((await code(response)) === 'provider_disabled') return this.switchOff();
    if (!response.ok) return keep();
    const text = await response.text().catch(() => '');
    let models: ServedModel[] | undefined;
    try {
      models = text.length <= 65536 ? parseList(JSON.parse(text)) : undefined;
    } catch {
      /* Not a list. */
    }
    if (!models) return keep();
    await this.store.put<ModelList>(this.key, {
      models,
      checkedAt: Date.now(),
      signedIn: Boolean(token),
    });
    return models;
  }
  private async switchOff() {
    await this.store.put<ModelList>(this.key, {
      models: [],
      checkedAt: Date.now(),
      signedIn: Boolean(await this.connection.token()),
    });
    return [];
  }
  /** Signed in, turned on, and the server offers a model. */
  async usable(): Promise<boolean> {
    return Boolean((await this.list()).length && (await this.connection.token()));
  }
  /** The model chosen on this device, or the first one the server lists. */
  async chosen(): Promise<ServedModel | undefined> {
    const models = await this.list();
    const id = await this.store.get<string>('model-choice:' + this.id);
    return models.find((model) => model.id === id) ?? models[0];
  }
  private get consentKey() {
    return 'connection-consent:' + this.id;
  }
  /** The user was told where messages to these models go, on this device. */
  async consented(): Promise<boolean> {
    return (await this.store.get<boolean>(this.consentKey)) === true;
  }
  async consent() {
    await this.store.put(this.consentKey, true);
  }
  async choose(id: string) {
    if (!(await this.list()).some((model) => model.id === id))
      throw new Error('This model is not available. Choose another.');
    await this.store.put('model-choice:' + this.id, id);
  }
  async settings() {
    const model = await this.chosen();
    return model ? { model: model.id } : {};
  }
  private async failure(response: Response, token: string): Promise<Error> {
    const reason = await code(response);
    if (reason === 'invalid_token') {
      if (token) await this.connection.rejected(token);
      return new SignInRequired(this.signIn());
    }
    if (response.status === 402 || reason === 'insufficient_credits') return this.outOfCredits();
    if (reason === 'provider_disabled') {
      await this.switchOff();
      return this.unavailable();
    }
    if (response.status === 429 || reason === 'rate_limited')
      return new RateLimited(this.busy(), retryAfter(response.headers.get('Retry-After')));
    // Any other refusal: signing in again would not help.
    if (response.status === 401 || response.status === 403) return this.unavailable();
    return httpFailure(response, {
      signIn: this.signIn(),
      interrupted: `The connection to ${this.name} was interrupted.`,
      failed: `${this.name} request failed`,
    });
  }
  private streamError(reason: unknown, message: string, token?: string): Error | undefined {
    if (reason === 'insufficient_credits') return this.outOfCredits();
    if (reason === 'rate_limited') return new RateLimited(this.busy());
    if (reason === 'provider_disabled') {
      void this.switchOff();
      return this.unavailable();
    }
    if (reason === 'invalid_token') {
      if (token) void this.connection.rejected(token);
      return new SignInRequired(this.signIn());
    }
    return reason === 'upstream_error' ? new ConnectionError(message) : undefined;
  }
  private outOfCredits() {
    return new OutOfCredits(`You’re out of credits for ${this.name}.`);
  }
  private unavailable() {
    return new ModelFailure(`${this.name} isn’t available right now. Choose another model.`);
  }
  private busy() {
    return `${this.name} is busy right now. Trying again shortly.`;
  }
}

/** The error code in a JSON error body, read from a copy so the body stays readable. */
async function code(response: Response): Promise<unknown> {
  if (response.ok) return undefined;
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
  return body?.error?.code;
}

/** Seconds or an HTTP date, kept between one second and ten minutes. */
export function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(600_000, Math.max(1000, ms)) : undefined;
}

/** `{ data: [{ id, name, images, context_window }] }`; `undefined` when it is not a list at all. */
export function parseList(value: unknown): ServedModel[] | undefined {
  const data = (value as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return undefined;
  return data
    .filter(
      (item): item is { id: string; name: string; images?: unknown; context_window?: unknown } =>
        typeof item?.id === 'string' &&
        modelId.test(item.id) &&
        typeof item.name === 'string' &&
        /^[^\p{Cc}]{1,60}$/u.test(item.name) &&
        Boolean(item.name.trim()),
    )
    .slice(0, 20)
    .map((item) => {
      const window = item.context_window;
      return {
        id: item.id,
        name: item.name.trim(),
        ...(item.images === true ? { images: true } : {}),
        ...(Number.isInteger(window) &&
        (window as number) >= 1000 &&
        (window as number) <= 10_000_000
          ? { contextWindow: window as number }
          : {}),
      };
    });
}
