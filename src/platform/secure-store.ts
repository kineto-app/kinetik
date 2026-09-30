import { invoke } from '@tauri-apps/api/core';
import { Store } from '../browser/store';

/** Credentials never enter the workspace IndexedDB or its export. */
export class NativeStore extends Store {
  constructor(
    private namespace = 'workspace',
    private protectAll = false,
  ) {
    super(namespace === 'workspace' ? 'kinetik-oss-v1' : namespace);
  }
  private protected(key: string) {
    return this.protectAll || /^(connection-token:|connection-pending:)/.test(key);
  }
  override async get<T>(key: string): Promise<T | undefined> {
    if (!this.protected(key)) return super.get(key);
    const result = await invoke<{ value?: string }>('plugin:native|secure_get', {
      payload: { key: this.namespace + ':' + key },
    });
    return result.value ? JSON.parse(result.value) : undefined;
  }
  override async update<T>(key: string, update: (previous: T | undefined) => T): Promise<T> {
    if (!this.protected(key)) return super.update(key, update);
    return navigator.locks.request('credential:' + this.namespace + ':' + key, async () => {
      const value = update(await this.get<T>(key));
      await invoke('plugin:native|secure_put', {
        payload: { key: this.namespace + ':' + key, value: JSON.stringify(value) },
      });
      return value;
    });
  }
}
