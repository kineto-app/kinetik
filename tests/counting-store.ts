import { Store } from '../src/browser/store';

/** A Store that records the size of every write. */
export class CountingStore extends Store {
  writes: { key: string; bytes: number }[] = [];
  private count(key: string, value: unknown) {
    if (value !== undefined) this.writes.push({ key, bytes: JSON.stringify(value).length });
  }
  override async update<T>(key: string, update: (previous: T | undefined) => T): Promise<T> {
    return super.update<T>(key, (previous) => {
      const value = update(previous);
      this.count(key, value);
      return value;
    });
  }
  override async updateMany(keys: string[], update: (values: unknown[]) => [string, unknown][]) {
    return super.updateMany(keys, (values) => {
      const writes = update(values);
      for (const [key, value] of writes) this.count(key, value);
      return writes;
    });
  }
  bytes(prefix: string) {
    return this.writes.filter((w) => w.key.startsWith(prefix)).reduce((n, w) => n + w.bytes, 0);
  }
}
