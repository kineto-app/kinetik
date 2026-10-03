import type { Store } from './ports';

/** A Store in memory, for Node: each call completes without yielding, so it is atomic. */
export class MemoryStore implements Store {
  private records = new Map<string, unknown>();
  private read<T>(key: string) {
    return structuredClone(this.records.get(key)) as T | undefined;
  }
  private write(key: string, value: unknown) {
    if (value === undefined) this.records.delete(key);
    else this.records.set(key, structuredClone(value));
  }
  async get<T>(key: string) {
    return this.read<T>(key);
  }
  async getMany<T>(keys: string[]) {
    return keys.map((key) => this.read<T>(key));
  }
  async update<T>(key: string, update: (previous: T | undefined) => T) {
    const value = update(this.read<T>(key));
    this.write(key, value);
    return value;
  }
  async updateMany(keys: string[], update: (values: unknown[]) => [string, unknown][]) {
    const writes = update(keys.map((key) => this.read(key)));
    for (const [key, value] of writes) this.write(key, value);
  }
  async put<T>(key: string, value: T) {
    this.write(key, value);
  }
  async delete(key: string) {
    this.records.delete(key);
  }
  async replace(records: [string, unknown][], retain: (key: string) => boolean) {
    for (const key of [...this.records.keys()]) if (!retain(key)) this.records.delete(key);
    for (const [key, value] of records) this.write(key, value);
  }
  async entries<T>(prefix: string) {
    return [...this.records.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key): [string, T] => [key, this.read<T>(key)!]);
  }
  async keys(prefix: string) {
    return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
