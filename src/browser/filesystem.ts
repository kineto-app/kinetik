import { InMemoryFs, type IFileSystem } from 'just-bash/browser';
import type { Store } from '../core/ports';

type Entry = {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'link';
  mode: number;
  mtime: Date;
  bytes?: Uint8Array;
  target?: string;
};
type Snapshot = { revision: string; entries: Entry[] };
const mutations = new Set([
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'chmod',
  'symlink',
  'link',
  'utimes',
]);
const MAX_BYTES = 16 * 1024 * 1024;

async function snapshot(fs: InMemoryFs): Promise<Snapshot> {
  const entries: Entry[] = [];
  const identities = new Map<string, string>();
  let bytes = 0;
  for (const path of fs.getAllPaths().sort()) {
    const stat = await fs.lstat(path);
    const entry: Entry = {
      path,
      mode: stat.mode,
      mtime: stat.mtime,
      kind: stat.isDirectory ? 'directory' : stat.isSymbolicLink ? 'symlink' : 'file',
    };
    if (entry.kind === 'symlink') entry.target = await fs.readlink(path);
    if (entry.kind === 'file') {
      const id = stat.identity ?? (stat.ino === undefined ? path : String(stat.ino));
      if (identities.has(id)) {
        entry.kind = 'link';
        entry.target = identities.get(id);
      } else {
        identities.set(id, path);
        entry.bytes = await fs.readFileBuffer(path);
        bytes += entry.bytes.byteLength;
      }
    }
    entries.push(entry);
  }
  if (entries.length > 2000 || bytes > MAX_BYTES)
    throw new Error('Workspace limit reached: 2,000 entries or 16 MiB. Export and remove files.');
  return { revision: crypto.randomUUID(), entries };
}
async function restore(saved?: Snapshot): Promise<InMemoryFs> {
  const fs = new InMemoryFs({}, { maxTotalBytes: MAX_BYTES });
  if (!saved) {
    await fs.mkdir('/workspace', { recursive: true });
    return fs;
  }
  // Clear built-in directories, then reconstruct explicit metadata and hard links.
  for (const name of await fs.readdir('/'))
    await fs.rm('/' + name, { recursive: true, force: true });
  for (const entry of saved.entries
    .filter((e) => e.kind === 'directory')
    .sort((a, b) => a.path.length - b.path.length)) {
    await fs.mkdir(entry.path, { recursive: true });
  }
  for (const entry of saved.entries) {
    if (entry.kind === 'file') await fs.writeFile(entry.path, entry.bytes!);
    if (entry.kind === 'symlink') await fs.symlink(entry.target!, entry.path);
  }
  for (const entry of saved.entries)
    if (entry.kind === 'link') await fs.link(entry.target!, entry.path);
  for (const entry of saved.entries) {
    if (entry.kind !== 'symlink') {
      await fs.chmod(entry.path, entry.mode);
      await fs.utimes(entry.path, entry.mtime, entry.mtime);
    }
  }
  return fs;
}

/** One commit per filesystem operation, not per shell invocation. Small-workspace prototype. */
export async function createFilesystem(store: Store): Promise<{
  fs: IFileSystem;
  edit(path: string, oldText: string, newText: string): Promise<void>;
}> {
  let saved = await store.get<Snapshot>('filesystem');
  let current = await restore(saved);
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(write: boolean, operation: (fs: InMemoryFs) => Promise<T>): Promise<T> => {
    const perform = async () => {
      const disk = await store.get<Snapshot>('filesystem');
      if (disk?.revision !== saved?.revision) {
        saved = disk;
        current = await restore(saved);
      }
      try {
        const result = await operation(current);
        if (write) {
          const next = await snapshot(current);
          await store.put('filesystem', next);
          saved = next;
        }
        return result;
      } catch (error) {
        current = await restore(saved);
        throw error;
      }
    };
    const result = tail.then(() =>
      globalThis.navigator?.locks
        ? navigator.locks.request('kinetik-filesystem', perform)
        : perform(),
    );
    tail = result.catch(() => undefined);
    return result;
  };
  const names = [
    'readFile',
    'readFileBuffer',
    'writeFile',
    'appendFile',
    'exists',
    'stat',
    'mkdir',
    'readdir',
    'rm',
    'cp',
    'mv',
    'chmod',
    'symlink',
    'link',
    'readlink',
    'lstat',
    'realpath',
    'utimes',
  ] as const;
  // Explicit own methods also survive just-bash's execution-scope facade.
  const methods = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) =>
        run(mutations.has(name), async (inner) => {
          const method = inner[name] as (...args: unknown[]) => Promise<unknown>;
          return method.apply(inner, args);
        }),
    ]),
  ) as Pick<IFileSystem, (typeof names)[number]>;
  const fs: IFileSystem = {
    ...methods,
    getAllPaths: () => current.getAllPaths(),
    resolvePath: (base, path) => current.resolvePath(base, path),
  };
  return {
    fs,
    edit: (path, oldText, newText) =>
      run(true, async (inner) => {
        const text = await inner.readFile(path);
        if (!oldText || text.split(oldText).length !== 2)
          throw new Error('Edit must match exactly one non-empty occurrence.');
        await inner.writeFile(
          path,
          text.replace(oldText, () => newText),
        );
      }),
  };
}
