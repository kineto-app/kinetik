import type { Store } from '../browser/store';
import { allowedURL } from '../plugins/loader';

export interface ConnectionPreset {
  url: string;
  resource: string;
  issuer: string;
  metadataUrl: string;
}
export interface Configuration {
  connections: { charms?: ConnectionPreset };
  chatgpt?: { apiBase: string };
}

// Deployment-owned configuration, never taken from deep-link parameters.
export function parseConfiguration(value: unknown, base: URL): Configuration {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid connection configuration.');
  const input = value as Record<string, any>;
  const config: Configuration = { connections: {} };
  const address = (value: unknown) => {
    if (typeof value !== 'string' || !value) throw new Error('Missing connection address.');
    const url = allowedURL(new URL(value, base).href);
    if (url.hash || url.search)
      throw new Error('Connection addresses cannot contain query strings.');
    return url.href;
  };
  if (input.connections?.charms) {
    const p = input.connections.charms;
    config.connections.charms = {
      url: address(p.url),
      resource: address(p.resource),
      issuer: address(p.issuer),
      metadataUrl: address(p.metadataUrl),
    };
  }
  if (input.chatgpt) {
    const apiBase = new URL(address(input.chatgpt.apiBase));
    if (apiBase.origin !== base.origin || !apiBase.pathname.endsWith('/'))
      throw new Error('The credential helper must be on this app’s origin.');
    config.chatgpt = { apiBase: apiBase.href };
  }
  return config;
}

export async function loadConfiguration(base: URL, store: Store): Promise<Configuration> {
  let response: Response;
  try {
    response = await fetch(new URL('config.json', base), {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return (await store.get<Configuration>('deployment-config')) ?? { connections: {} };
  }
  if (!response.ok) {
    if (response.status === 404) return { connections: {} };
    throw new Error('Connection settings could not be loaded. Reopen the app to retry.');
  }
  const config = parseConfiguration(await response.json(), base);
  await store.put('deployment-config', config);
  return config;
}
