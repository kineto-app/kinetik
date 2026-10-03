/**
 * The storage the agent core needs. The app uses IndexedDB (browser/store.ts); evals and tests
 * in Node use MemoryStore. Values are copied in and out, as IndexedDB does.
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  getMany<T>(keys: string[]): Promise<(T | undefined)[]>;
  /** Reads, updates and writes one key atomically; returning `undefined` deletes it. */
  update<T>(key: string, update: (previous: T | undefined) => T): Promise<T>;
  /** Reads `keys` and applies the returned writes in one transaction; `undefined` deletes. */
  updateMany(keys: string[], update: (values: unknown[]) => [string, unknown][]): Promise<void>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Replaces every record except those `retain` keeps. */
  replace(records: [string, unknown][], retain: (key: string) => boolean): Promise<void>;
  entries<T>(prefix: string): Promise<[string, T][]>;
  keys(prefix: string): Promise<string[]>;
}
