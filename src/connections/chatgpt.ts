import { ConnectionError, SignInRequired } from '../core/connection-error';
import { Store } from '../browser/store';

const issuer = 'https://auth.openai.com';
const tokenEndpoint = issuer + '/api/accounts/oauth/token';
const redirectUri = 'http://127.0.0.1:1455/auth/callback';
const resource = 'https://api.openai.com/v1';
const defaultModel = 'gpt-6.1-sol';
export interface ChatGPTModel {
  slug: string;
  name: string;
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
interface Registration {
  hostId: string;
  clientId?: string;
  subject?: string;
}
interface Pending {
  redirectUri?: string;
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
}
interface Session {
  idToken?: string;
  scopes?: string[];
  access: string;
  refresh: string;
  expires: number;
  model: string;
  modelSelected?: boolean;
  account: string;
}

/** Browser credentials are kept separately from workspace files and conversation history. */
export class BrowserChatGPT {
  private async storedSession(): Promise<Session | undefined> {
    const session = await this.store.get<Session | null>('session');
    if (
      !session ||
      !Number.isFinite(session.expires) ||
      ![session.access, session.refresh, session.account, session.model].every(
        (value) => typeof value === 'string' && value.length > 0,
      )
    )
      return;
    return session;
  }
  constructor(
    private jwksUrl: string,
    private store = new Store('kinetik-chatgpt-v1'),
    private request: typeof fetch = fetch.bind(globalThis),
    private modelRelay?: string,
  ) {}
  private async json(url: string, init: RequestInit = {}, stage = 'request') {
    let response: Response;
    let text: string;
    try {
      response = await this.request(url, {
        ...init,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(30000),
      });
      text = await response.text();
    } catch {
      // Browser fetch errors hide whether DNS, TLS, CORS or connectivity failed.
      // Identify the request without leaking callback codes or token responses.
      if (stage === 'model list')
        throw new Error('Could not load models. Check your connection and try again.');
      throw new Error(
        `Could not reach ChatGPT (${stage}). Check your connection, then restart sign-in.`,
      );
    }
    if (!response.ok)
      throw new Error(
        `ChatGPT returned HTTP ${response.status} (${stage}). ${stage === 'model list' ? 'Try again.' : 'Restart sign-in.'}`,
      );
    if (text.length > 1024 * 1024) throw new Error('ChatGPT response was too large.');
    return text ? JSON.parse(text) : {};
  }
  async status() {
    const session = await this.storedSession();
    return { connected: !!session, model: session?.model ?? '', account: session?.account ?? '' };
  }
  async login(callbackUri = redirectUri) {
    const callback = new URL(callbackUri);
    if (
      callback.protocol !== 'http:' ||
      callback.hostname !== '127.0.0.1' ||
      callback.pathname !== '/auth/callback' ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash
    )
      throw new Error('Invalid local callback address.');
    return navigator.locks.request('kinetik-chatgpt', async () => {
      const registration = await this.registration();
      const retained = await this.storedSession();
      const pending: Pending = {
        redirectUri: callbackUri,
        state: random(),
        nonce: random(),
        verifier: random(),
        expires: Date.now() + 15 * 60000,
      };
      await this.store.put('pending', pending);
      const url = new URL(issuer + '/api/accounts/authorize');
      url.search = new URLSearchParams({
        client_id: registration.clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: registration.hostId,
        response_type: 'code',
        redirect_uri: callbackUri,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        resource,
        state: pending.state,
        nonce: pending.nonce,
        code_challenge_method: 'S256',
        code_challenge: encode(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier)),
          ),
        ),
        ...(!registration.clientId ? { agent_name_hint: 'Kinetik OSS' } : {}),
        ...(registration.clientId && retained?.idToken ? { id_token_hint: retained.idToken } : {}),
      }).toString();
      return { url: url.href };
    });
  }
  private async registration(): Promise<Registration> {
    return this.store.update<Registration>(
      'registration',
      (old) => old ?? { hostId: 'urn:uuid:' + crypto.randomUUID() },
    );
  }
  async callback(value: string) {
    return navigator.locks.request('kinetik-chatgpt', async () => {
      const url = new URL(value);
      const pending = await this.store.get<Pending | null>('pending');
      if (
        !pending ||
        pending.expires < Date.now() ||
        url.origin !== new URL(pending.redirectUri ?? redirectUri).origin ||
        url.pathname !== '/auth/callback' ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== pending.state
      )
        throw new Error('This return link does not match your sign-in. Start sign-in again.');
      await this.store.put('pending', null);
      if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined.');
      const registration = await this.registration();
      const supplied = url.searchParams.get('client_id');
      if (
        url.searchParams.getAll('client_id').length > 1 ||
        (registration.clientId && supplied && supplied !== registration.clientId)
      )
        throw new Error('Unexpected ChatGPT registration.');
      const clientId = registration.clientId ?? supplied;
      const code = url.searchParams.get('code');
      if (
        !clientId ||
        clientId === 'dynamic_agent_client' ||
        !code ||
        url.searchParams.getAll('code').length !== 1
      )
        throw new Error('The return link is incomplete. Start sign-in again.');
      const tokens = await this.json(
        tokenEndpoint,
        {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: pending.verifier,
            redirect_uri: pending.redirectUri ?? redirectUri,
            resource,
          }),
        },
        'token exchange',
      );
      const claims = await this.identity(tokens.id_token, clientId, pending.nonce);
      if (registration.subject && registration.subject !== claims.sub)
        throw new Error('ChatGPT account does not match this registration.');
      if (
        typeof tokens.scope !== 'string' ||
        !tokens.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')
      )
        throw new Error('ChatGPT plan access was not granted.');
      const session = this.session(tokens, String(claims.sub));
      session.model = await this.selectModel(session);
      await this.store.put('registration', { ...registration, clientId, subject: claims.sub });
      await this.store.put('session', session);
      return { ok: true };
    });
  }
  private async catalog(session: Session, signal?: AbortSignal): Promise<ChatGPTModel[]> {
    const catalog = await this.json(
      this.modelRelay ? this.modelRelay + 'models' : resource + '/models',
      {
        method: this.modelRelay ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + session.access,
          ...(this.modelRelay ? { 'Content-Type': 'application/json' } : {}),
        },
        body: this.modelRelay ? '{}' : undefined,
        signal,
      },
      'model list',
    );
    if (!Array.isArray(catalog.models)) throw new Error('ChatGPT returned an invalid model list.');
    const models = new Map<string, ChatGPTModel>();
    for (const model of catalog.models) {
      if (model?.visibility !== 'list' || typeof model.slug !== 'string' || !model.slug) continue;
      if (!models.has(model.slug))
        models.set(model.slug, {
          slug: model.slug,
          name:
            typeof model.display_name === 'string' && model.display_name
              ? model.display_name
              : model.slug,
        });
    }
    return [...models.values()];
  }
  private async selectModel(session: Session, signal?: AbortSignal) {
    if (!(await this.catalog(session, signal)).some((model) => model.slug === defaultModel))
      throw new Error('GPT-6.1 Sol is not available for this ChatGPT account.');
    return defaultModel;
  }
  async models() {
    const status = await this.status();
    const session = await this.access(status.account, AbortSignal.timeout(30000), false);
    return { models: await this.catalog(session), selected: session.model };
  }
  async chooseModel(slug: string) {
    const status = await this.status();
    const session = await this.access(status.account, AbortSignal.timeout(30000), false);
    if (!(await this.catalog(session)).some((model) => model.slug === slug))
      throw new Error('This model is not available. Refresh the list and choose another.');
    return navigator.locks.request('kinetik-chatgpt', async () => {
      const current = await this.storedSession();
      if (!current || current.account !== session.account)
        throw new Error('ChatGPT account changed. Choose the model again.');
      await this.store.put('session', { ...current, model: slug, modelSelected: true });
      return { model: slug };
    });
  }
  private session(tokens: Record<string, unknown>, account: string, previous?: Session): Session {
    if (
      typeof tokens.access_token !== 'string' ||
      !tokens.access_token ||
      (tokens.token_type as string)?.toLowerCase() !== 'bearer' ||
      typeof tokens.expires_in !== 'number' ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== 'string')
    )
      throw new Error('Invalid ChatGPT credentials.');
    const refresh = (tokens.refresh_token as string | undefined) ?? previous?.refresh;
    if (!refresh) throw new Error('ChatGPT did not grant renewable access.');
    return {
      idToken: typeof tokens.id_token === 'string' ? tokens.id_token : previous?.idToken,
      scopes:
        typeof tokens.scope === 'string'
          ? tokens.scope.split(/\s+/).filter(Boolean)
          : previous?.scopes,
      access: tokens.access_token,
      refresh,
      expires: Date.now() + tokens.expires_in * 1000,
      account,
      model: previous?.model ?? '',
      modelSelected: previous?.modelSelected,
    };
  }
  private async identity(raw: unknown, clientId: string, nonce?: string) {
    if (typeof raw !== 'string' || raw.length > 65536 || raw.split('.').length !== 3)
      throw new Error('Invalid ChatGPT identity.');
    const [head, payload, signature] = raw.split('.');
    const header = JSON.parse(new TextDecoder().decode(decode(head)));
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string')
      throw new Error('Unsupported ChatGPT identity signature.');
    // Public signing keys; OAuth code exchange and refresh go directly to OpenAI.
    const jwks = await this.json(this.jwksUrl, {}, 'identity keys');
    const jwk = jwks.keys?.find(
      (k: JsonWebKey & { kid?: string }) =>
        k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'),
    );
    if (!jwk) throw new Error('ChatGPT signing key unavailable. Start sign-in again.');
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        decode(signature),
        new TextEncoder().encode(head + '.' + payload),
      ))
    )
      throw new Error('ChatGPT identity signature rejected.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Date.now() / 1000;
    if (
      claims.iss !== issuer ||
      !aud.includes(clientId) ||
      (aud.length > 1 && claims.azp !== clientId) ||
      typeof claims.exp !== 'number' ||
      claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + 30)) ||
      (nonce !== undefined && claims.nonce !== nonce) ||
      typeof claims.sub !== 'string' ||
      !claims.sub
    )
      throw new Error('ChatGPT identity validation failed.');
    return claims;
  }
  private async access(account: string, signal: AbortSignal, migrateModel = true) {
    return navigator.locks.request('kinetik-chatgpt', async () => {
      let session = await this.storedSession();
      if (!session) throw new SignInRequired('Connect ChatGPT in Connections to continue.');
      if (account !== session.account)
        throw new Error('ChatGPT account changed. Retry your message.');
      if (session.expires < Date.now() + 60000) {
        const registration = await this.registration();
        const response = await this.request(tokenEndpoint, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: registration.clientId!,
            refresh_token: session.refresh,
            resource,
          }),
        });
        if (!response.ok) {
          if ([400, 401, 403].includes(response.status)) {
            await this.store.put('session', null);
            throw new SignInRequired('Reconnect ChatGPT to continue.');
          }
          throw new ConnectionError('ChatGPT session could not be renewed.');
        }
        const tokens = await response.json();
        if (
          tokens.scope !== undefined &&
          (typeof tokens.scope !== 'string' ||
            !tokens.scope.split(/\s+/).includes('chatgpt.tokens.use.direct'))
        ) {
          await this.store.put('session', null);
          throw new SignInRequired('Reconnect ChatGPT to grant plan access.');
        }
        if (tokens.id_token !== undefined) {
          const identity = await this.identity(tokens.id_token, registration.clientId!);
          if (identity.sub !== session.account)
            throw new Error('ChatGPT account changed during renewal.');
        }
        session = this.session(tokens, session.account, session);
        await this.store.put('session', session);
      }
      if (migrateModel && !session.modelSelected && session.model !== defaultModel) {
        session.model = await this.selectModel(session, signal);
        await this.store.put('session', session);
      }
      return session;
    });
  }
  async responses(
    body: { account: string; request: Record<string, unknown> },
    signal: AbortSignal,
  ) {
    const session = await this.access(body.account, signal);
    return this.request(this.modelRelay ? this.modelRelay + 'responses' : resource + '/responses', {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal,
      headers: { Authorization: 'Bearer ' + session.access, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body.request,
        model: session.model,
        reasoning: session.model === defaultModel ? { effort: 'medium' } : undefined,
        store: false,
        stream: true,
      }),
    });
  }
  async logout() {
    return navigator.locks.request('kinetik-chatgpt', async () => {
      const session = await this.storedSession();
      const registration = await this.registration();
      await this.store.put('session', null);
      await this.store.put('pending', null);
      if (session && registration.clientId) {
        try {
          await this.json(issuer + '/api/accounts/oauth/revoke', {
            method: 'POST',
            body: new URLSearchParams({
              token: session.refresh,
              token_type_hint: 'refresh_token',
              client_id: registration.clientId,
            }),
          });
        } catch {
          throw new Error(
            'Signed out on this device. Revoke Kinetik in ChatGPT Settings to confirm remote sign-out.',
          );
        }
      }
      return { ok: true };
    });
  }
}
