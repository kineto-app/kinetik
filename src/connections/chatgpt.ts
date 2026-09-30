import { Store } from '../browser/store';

const issuer = 'https://auth.openai.com';
const tokenEndpoint = issuer + '/api/accounts/oauth/token';
const redirectUri = 'http://127.0.0.1:1455/auth/callback';
const resource = 'https://api.openai.com/v1';
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
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
}
interface Session {
  access: string;
  refresh: string;
  expires: number;
  model: string;
  account: string;
}

/** Experimental session-only credentials. Lost when the browser discards this worker. */
export class BrowserChatGPT {
  private current?: Session;
  private cleared?: Promise<void>;
  private prepare() {
    // Remove credentials saved by the earlier experimental browser-storage build.
    return (this.cleared ??= this.store.put('session', null));
  }
  constructor(
    private jwksUrl: string,
    private store = new Store('kinetik-chatgpt-v1'),
    private request: typeof fetch = fetch.bind(globalThis),
  ) {}
  private async json(url: string, init: RequestInit = {}) {
    const response = await this.request(url, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`ChatGPT returned HTTP ${response.status}. Try again or reconnect.`);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('ChatGPT response was too large.');
    return text ? JSON.parse(text) : {};
  }
  async status() {
    await this.prepare();
    const session = this.current;
    return { connected: !!session, model: session?.model ?? '', account: session?.account ?? '' };
  }
  async login() {
    await this.prepare();
    return navigator.locks.request('kinetik-chatgpt', async () => {
      const registration = await this.registration();
      const pending: Pending = {
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
        redirect_uri: redirectUri,
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
    await this.prepare();
    return navigator.locks.request('kinetik-chatgpt', async () => {
      const url = new URL(value);
      const pending = await this.store.get<Pending | null>('pending');
      if (
        !pending ||
        pending.expires < Date.now() ||
        url.origin !== new URL(redirectUri).origin ||
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
      const tokens = await this.json(tokenEndpoint, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: pending.verifier,
          redirect_uri: redirectUri,
          resource,
        }),
      });
      const claims = await this.identity(tokens.id_token, clientId, pending.nonce);
      if (registration.subject && registration.subject !== claims.sub)
        throw new Error('ChatGPT account does not match this registration.');
      if (
        typeof tokens.scope !== 'string' ||
        !tokens.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')
      )
        throw new Error('ChatGPT plan access was not granted.');
      const session = this.session(tokens, String(claims.sub));
      const catalog = await this.json(resource + '/models', {
        headers: { Authorization: 'Bearer ' + session.access },
      });
      const models = Array.isArray(catalog.models)
        ? catalog.models.filter(
            (m: { visibility?: string; slug?: string }) =>
              m.visibility === 'list' && typeof m.slug === 'string',
          )
        : [];
      session.model = models[0]?.slug ?? '';
      if (!session.model) throw new Error('No ChatGPT models are available for this account.');
      await this.store.put('registration', { ...registration, clientId, subject: claims.sub });
      this.current = session;
      return { ok: true };
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
      access: tokens.access_token,
      refresh,
      expires: Date.now() + tokens.expires_in * 1000,
      account,
      model: previous?.model ?? '',
    };
  }
  private async identity(raw: unknown, clientId: string, nonce: string) {
    if (typeof raw !== 'string' || raw.length > 65536 || raw.split('.').length !== 3)
      throw new Error('Invalid ChatGPT identity.');
    const [head, payload, signature] = raw.split('.');
    const header = JSON.parse(new TextDecoder().decode(decode(head)));
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string')
      throw new Error('Unsupported ChatGPT identity signature.');
    // The host relays public signing keys only; OAuth credentials go directly to OpenAI.
    const jwks = await this.json(this.jwksUrl);
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
      claims.nonce !== nonce ||
      typeof claims.sub !== 'string' ||
      !claims.sub
    )
      throw new Error('ChatGPT identity validation failed.');
    return claims;
  }
  private async access() {
    await this.prepare();
    return navigator.locks.request('kinetik-chatgpt', async () => {
      let session = this.current;
      if (!session) throw new Error('Connect ChatGPT in Connections to continue.');
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
          if ([400, 401, 403].includes(response.status)) this.current = undefined;
          throw new Error('ChatGPT session could not be renewed. Try again or reconnect.');
        }
        session = this.session(await response.json(), session.account, session);
        this.current = session;
      }
      return session;
    });
  }
  async responses(
    body: { account: string; request: Record<string, unknown> },
    signal: AbortSignal,
  ) {
    const session = await this.access();
    if (body.account !== session.account)
      throw new Error('ChatGPT account changed. Retry your message.');
    return this.request(resource + '/responses', {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal,
      headers: { Authorization: 'Bearer ' + session.access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body.request, model: session.model, store: false, stream: true }),
    });
  }
  async logout() {
    await this.prepare();
    return navigator.locks.request('kinetik-chatgpt', async () => {
      const session = this.current;
      const registration = await this.registration();
      this.current = undefined;
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
