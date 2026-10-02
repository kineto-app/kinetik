/** A write resolves on commit, never just on request success. Updaters are synchronous. */
export class Store {
  private database?: Promise<IDBDatabase>;
  constructor(private name = 'kinetik-oss-v1') {}
  private open(): Promise<IDBDatabase> {
    return (this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    }));
  }
  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }
  async update<T>(key: string, update: (previous: T | undefined) => T): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const records = tx.objectStore('records');
      let value: T;
      let failure: unknown;
      const request = records.get(key);
      request.onsuccess = () => {
        try {
          value = update(request.result as T | undefined);
          records.put(value, key);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () =>
        reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
    });
  }
  async getMany<T>(keys: string[]): Promise<(T | undefined)[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const records = db.transaction('records').objectStore('records');
      const values: (T | undefined)[] = [];
      let left = keys.length;
      if (!left) resolve(values);
      keys.forEach((key, index) => {
        const request = records.get(key);
        request.onsuccess = () => {
          values[index] = request.result as T | undefined;
          if (--left === 0) resolve(values);
        };
        request.onerror = () => reject(request.error);
      });
    });
  }
  /**
   * Reads `keys` and applies the writes the updater returns in one transaction.
   * A write of `undefined` deletes the key.
   */
  async updateMany(
    keys: string[],
    update: (values: unknown[]) => [string, unknown][],
  ): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const records = tx.objectStore('records');
      const values: unknown[] = [];
      let left = keys.length;
      let failure: unknown;
      const apply = () => {
        try {
          for (const [key, value] of update(values))
            if (value === undefined) records.delete(key);
            else records.put(value, key);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      keys.forEach((key, index) => {
        const request = records.get(key);
        request.onsuccess = () => {
          values[index] = request.result;
          if (--left === 0) apply();
        };
      });
      if (!left) apply();
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
    });
  }
  async put<T>(key: string, value: T): Promise<void> {
    await this.update(key, () => value);
  }
  async delete(key: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction aborted'));
    });
  }
  /** Replace application records atomically, retaining device-owned records selected by the caller. */
  async replace(records: [string, unknown][], retain: (key: string) => boolean): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const objectStore = tx.objectStore('records');
      const cursorRequest = objectStore.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          if (!retain(String(cursor.key))) cursor.delete();
          cursor.continue();
        } else for (const [key, value] of records) objectStore.put(value, key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Import transaction aborted'));
    });
  }
  async entries<T>(prefix: string): Promise<[string, T][]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').openCursor();
      const result: [string, T][] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(result);
        if (String(cursor.key).startsWith(prefix))
          result.push([String(cursor.key), cursor.value as T]);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
}
