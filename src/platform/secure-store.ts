import { invoke } from '@tauri-apps/api/core';
import { Store } from '../browser/store';
import { writeWorkspace } from './update-workspace';

/** Credentials never enter the workspace IndexedDB or its export. */
export class NativeStore extends Store {
  constructor(
    private namespace = 'workspace',
    private protectAll = false,
  ) {
    super(namespace === 'workspace' ? 'kinetik-oss-v1' : namespace);
  }
  private write<T>(work: () => Promise<T>): Promise<T> {
    return this.namespace === 'workspace' ? writeWorkspace(work) : work();
  }
  override async delete(key: string): Promise<void> {
    return this.write(() => super.delete(key));
  }
  override async replace(
    records: [string, unknown][],
    retain: (key: string) => boolean,
  ): Promise<void> {
    return this.write(() => super.replace(records, retain));
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
  override async getMany<T>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.some((key) => this.protected(key)))
      throw new Error('Credentials are read one at a time.');
    return super.getMany(keys);
  }
  override async updateMany(keys: string[], update: (values: unknown[]) => [string, unknown][]) {
    if (keys.some((key) => this.protected(key)))
      throw new Error('Credentials are written one at a time.');
    return this.write(() =>
      super.updateMany(keys, (values) => {
        const writes = update(values);
        if (writes.some(([key]) => this.protected(key)))
          throw new Error('Credentials are written one at a time.');
        return writes;
      }),
    );
  }
  override async update<T>(key: string, update: (previous: T | undefined) => T): Promise<T> {
    if (!this.protected(key)) return this.write(() => super.update(key, update));
    return navigator.locks.request('credential:' + this.namespace + ':' + key, async () => {
      const value = update(await this.get<T>(key));
      await invoke('plugin:native|secure_put', {
        payload: { key: this.namespace + ':' + key, value: JSON.stringify(value) },
      });
      return value;
    });
  }
}
