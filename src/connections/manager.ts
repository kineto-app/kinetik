import type { Store } from '../browser/store';
import { allowedURL, Plugins } from '../plugins/loader';
import type { Configuration, ConnectionPreset } from './config';
import { credentialKey, usable, type Credential } from './credentials';

interface Connection {
  preset: ConnectionPreset;
  clientId?: string;
  revocationEndpoint?: string;
}
interface Pending {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  expiresAt: number;
  preset: ConnectionPreset;
  digest: string;
}
export interface ConnectionState {
  available: boolean;
  status: 'not-connected' | 'connected' | 'disabled' | 'reconnect';
}
export interface SetupState {
  installation: { required: boolean };
  charms: ConnectionState;
  chatgpt: { available: boolean; connected: boolean; apiBase?: string };
}
const id = 'charms';
const recordKey = 'connection:' + id;
const pendingKey = 'connection-pending:' + id;
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const same = (a: ConnectionPreset, b: ConnectionPreset) => JSON.stringify(a) === JSON.stringify(b);

async function json(url: string, init: RequestInit = {}): Promise<Record<string, any>> {
  const response = await fetch(url, {
    ...init,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(`Could not connect to Charms (HTTP ${response.status}). Try again.`);
  const text = await response.text();
  if (text.length > 65536) throw new Error('Connection response was too large.');
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid connection response.');
  return value;
}

/** OAuth state and credentials stay in the worker store, out of plugin settings and chat snapshots. */
export class Connections {
  constructor(
    private store: Store,
    private plugins: Plugins,
    private config: Configuration,
    private base: URL,
  ) {}

  private async installed() {
    return (await this.plugins.list()).find((p) => p.manifest.id === id);
  }
  private source() {
    return new URL('plugins/charms/plugin.json', this.base).href;
  }
  private preset() {
    const preset = this.config.connections.charms;
    if (!preset) throw new Error('Charms is not configured on this host.');
    return preset;
  }
  private async assertManaged() {
    const plugin = await this.installed();
    const connection = await this.store.get<Connection>(recordKey);
    if (
      !plugin ||
      plugin.source !== this.source() ||
      plugin.settings.connection !== id ||
      plugin.settings.url !== this.preset().url ||
      !connection ||
      !same(connection.preset, this.preset())
    )
      throw new Error(
        'Your existing Charms settings differ from this connection. Keep them or remove the custom connection before setting this one up.',
      );
    return { plugin, connection };
  }
  async state(): Promise<SetupState> {
    const plugin = await this.installed();
    const credential = await this.store.get<Credential>(credentialKey(id));
    const connection = await this.store.get<Connection>(recordKey);
    const preset = this.config.connections.charms;
    const valid = Boolean(
      connection &&
      preset &&
      same(connection.preset, preset) &&
      usable(credential) &&
      plugin?.source === this.source() &&
      plugin.settings.connection === id &&
      plugin.settings.url === preset.url &&
      plugin.settings.connectionRevision === credential.revision,
    );
    let connected = false;
    if (this.config.chatgpt) {
      try {
        const response = await fetch(new URL('status', this.config.chatgpt.apiBase), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(5000),
        });
        connected = response.ok && (await response.json()).connected === true;
      } catch {
        /* The UI keeps the sign-in step available for retry. */
      }
    }
    return {
      installation: { required: this.config.installation?.required === true },
      charms: {
        available: Boolean(preset),
        status: valid
          ? plugin?.enabledAt != null && credential?.ready
            ? 'connected'
            : 'disabled'
          : credential
            ? 'reconnect'
            : 'not-connected',
      },
      chatgpt: {
        available: Boolean(this.config.chatgpt),
        connected,
        apiBase: this.config.chatgpt?.apiBase,
      },
    };
  }
  async prepare(): Promise<void> {
    const preset = this.preset();
    // Following a link never updates, enables, or replaces an existing installation.
    if (await this.installed()) return;
    await this.plugins.install(this.source(), { url: preset.url, connection: id });
    await this.store.put<Connection>(recordKey, { preset });
  }
  async setEnabled(enabled: boolean): Promise<void> {
    await this.store.put(pendingKey, null);
    const plugin = await this.installed();
    if (enabled && plugin?.settings.connection === id) await this.activate();
    else await this.plugins.enable(id, enabled);
  }
  async begin(handoff = false): Promise<string> {
    await this.prepare();
    const { plugin, connection } = await this.assertManaged();
    const preset = this.preset();
    const metadata = await json(preset.metadataUrl);
    if (
      metadata.issuer !== preset.issuer ||
      !metadata.code_challenge_methods_supported?.includes('S256') ||
      !metadata.response_types_supported?.includes('code') ||
      !metadata.token_endpoint_auth_methods_supported?.includes('none')
    )
      throw new Error('Charms did not advertise a supported secure sign-in flow.');
    const endpoint = (value: unknown, authorize = false) => {
      if (typeof value !== 'string') throw new Error('Missing sign-in endpoint.');
      const url = allowedURL(value);
      const issuerOrigin = new URL(preset.issuer).origin;
      if (
        url.hash ||
        url.search ||
        (url.origin !== issuerOrigin && (authorize || url.origin !== this.base.origin))
      )
        throw new Error('Unrecognized sign-in endpoint.');
      return url.href;
    };
    const authorizationEndpoint = endpoint(metadata.authorization_endpoint, true);
    const tokenEndpoint = endpoint(metadata.token_endpoint);
    const revocationEndpoint = metadata.revocation_endpoint
      ? endpoint(metadata.revocation_endpoint)
      : undefined;
    const redirect = new URL(this.base);
    redirect.search = '?connection_callback=charms';
    const redirectUri = redirect.href;
    let clientId = connection.clientId;
    if (!clientId) {
      const registration = await json(endpoint(metadata.registration_endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Kinetik OSS',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });
      if (
        typeof registration.client_id !== 'string' ||
        !registration.client_id ||
        registration.client_id.length > 1024
      )
        throw new Error('Charms did not return a client identifier.');
      clientId = registration.client_id;
      await this.store.put(recordKey, { ...connection, clientId });
    }
    const verifier = random();
    // The prefix selects return instructions only; the full random value is still verified.
    const state = (handoff ? 'app.' : '') + random();
    const challenge = encode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    await this.store.put<Pending>(pendingKey, {
      state,
      verifier,
      clientId,
      redirectUri,
      tokenEndpoint,
      revocationEndpoint,
      expiresAt: Date.now() + 10 * 60 * 1000,
      preset,
      digest: plugin.digest,
    });
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: preset.resource,
    }).toString();
    return url.href;
  }
  async finish(input: {
    state: string;
    code?: string;
    error?: string;
    issuer?: string;
  }): Promise<void> {
    const pending = await this.store.get<Pending>(pendingKey);
    if (
      !pending ||
      pending.state !== input.state ||
      pending.expiresAt < Date.now() ||
      !same(pending.preset, this.preset()) ||
      (input.issuer && input.issuer !== pending.preset.issuer)
    )
      throw new Error(
        'This sign-in link expired or belongs to another session. Connect Charms again.',
      );
    // Consume once before exchanging the code; a failed exchange requires a fresh authorization.
    await this.store.put(pendingKey, null);
    if (input.error)
      throw new Error('Charms wasn’t connected. You can try again whenever you’re ready.');
    if (!input.code || input.code.length > 8192)
      throw new Error('Missing sign-in code. Connect Charms again.');
    const { plugin, connection } = await this.assertManaged();
    if (plugin.digest !== pending.digest)
      throw new Error('The connection changed during sign-in. Please try again.');
    const token = await json(pending.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
        resource: pending.preset.resource,
      }),
    });
    if (
      typeof token.access_token !== 'string' ||
      !/^[\x21-\x7e]{1,16384}$/.test(token.access_token) ||
      String(token.token_type).toLowerCase() !== 'bearer' ||
      (token.expires_in !== undefined &&
        (!Number.isFinite(token.expires_in) || token.expires_in <= 0))
    )
      throw new Error('Charms returned an invalid credential.');
    const revision = crypto.randomUUID();
    await this.plugins.configure(id, { ...plugin.settings, connectionRevision: revision });
    await this.store.put<Credential>(credentialKey(id), {
      token: token.access_token,
      revision,
      ready: false,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    });
    await this.store.put(recordKey, {
      ...connection,
      revocationEndpoint: pending.revocationEndpoint,
    });
    await this.activate();
  }
  async activate(): Promise<void> {
    const { plugin } = await this.assertManaged();
    const provider = await this.plugins.instantiate(plugin, true);
    // Verify tools and load native skills before switching the workspace provider.
    const synced = await this.plugins.sync(
      [{ installed: plugin, plugin: provider }],
      AbortSignal.timeout(45000),
    );
    if (synced.warnings.length)
      throw new Error(
        'Charms connected, but its skills could not be loaded. Try enabling Charms again.',
      );
    await this.store.update<Credential>(credentialKey(id), (credential) => {
      if (!usable(credential) || credential.revision !== plugin.settings.connectionRevision)
        throw new Error('The connection changed. Please reconnect Charms.');
      return { ...credential, ready: true };
    });
    await this.plugins.enable(id, true);
  }
  async disconnect(): Promise<void> {
    const { connection } = await this.assertManaged();
    const credential = await this.store.get<Credential>(credentialKey(id));
    await this.store.put(pendingKey, null);
    await this.plugins.enable(id, false);
    await this.store.put(credentialKey(id), null);
    if (credential && connection.revocationEndpoint) {
      try {
        await json(connection.revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: credential.token, token_type_hint: 'access_token' }),
        });
      } catch {
        throw new Error(
          'Disconnected on this device. Remote access could not be revoked; revoke it from your Charms account.',
        );
      }
    }
  }
}
