import type { Store } from '../browser/store';
import type { createFilesystem } from '../browser/filesystem';
import type { Plugins } from '../plugins/loader';
import { localTools } from './tools';

/** The files browser, import and export over the local workspace. */
export class WorkspaceFiles {
  constructor(
    private store: Store,
    private plugins: Plugins,
    private workspace: ReturnType<typeof createFilesystem>,
    private changed: () => void,
  ) {}
  async list() {
    const { fs } = await this.workspace;
    const files: { path: string; name: string; size: number }[] = [];
    const visit = async (directory: string) => {
      for (const name of await fs.readdir(directory)) {
        const path = directory + '/' + name;
        try {
          const stat = await fs.lstat(path);
          if (stat.isDirectory) await visit(path);
          else if (stat.isFile) files.push({ path, name, size: stat.size });
        } catch {
          /* A concurrent task may have moved or deleted the file. */
        }
      }
    };
    await visit('/workspace');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  async readMonitor(path: string): Promise<string> {
    const snapshot = await this.plugins.snapshot(
      localTools(await this.workspace, () => [], this.store),
    );
    const result = await snapshot.bindings.read.tool.execute(
      { path },
      { signal: AbortSignal.timeout(10000), checkpoint: async () => {} },
    );
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
  async importFile(name: string, bytes: Uint8Array): Promise<void> {
    if (
      !name ||
      name.includes('/') ||
      name.includes('\\') ||
      name === '.' ||
      name === '..' ||
      bytes.byteLength > 4 * 1024 * 1024
    )
      throw new Error('Import a file up to 4 MiB with a plain filename.');
    await (await this.workspace).fs.writeFile('/workspace/' + name, bytes);
    this.changed();
  }
  async exportSharedFile(id: string): Promise<Uint8Array> {
    const bytes = await this.store.get<Uint8Array>('shared-file:' + id);
    if (!bytes) throw new Error('Shared file not found.');
    return bytes;
  }
  async exportFile(path: string): Promise<Uint8Array> {
    return (await this.workspace).fs.readFileBuffer(path);
  }
}
