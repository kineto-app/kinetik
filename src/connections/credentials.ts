import type { Store } from '../core/ports';

export interface Credential {
  token: string;
  revision: string;
  ready: boolean;
  expiresAt?: number;
  invalid?: boolean;
}
export const credentialKey = (id: string) => 'connection-token:' + id;
export function usable(credential: Credential | null | undefined): credential is Credential {
  return Boolean(
    credential &&
    !credential.invalid &&
    (!credential.expiresAt || credential.expiresAt > Date.now() + 5000),
  );
}
export async function connectionToken(
  store: Store,
  id: string,
  revision: string,
  validating = false,
): Promise<string> {
  const credential = await store.get<Credential>(credentialKey(id));
  if (!usable(credential) || credential.revision !== revision)
    throw new Error('Reconnect Charms in Connections to continue.');
  if (!credential.ready && !validating)
    throw new Error('Finish connecting Charms in Connections to continue.');
  return credential.token;
}
export async function invalidateToken(store: Store, id: string, token: string) {
  await store.update<Credential | null>(credentialKey(id), (current) =>
    current?.token === token ? { ...current, invalid: true } : (current ?? null),
  );
}
