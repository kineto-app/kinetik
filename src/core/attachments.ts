import type { Store } from '../browser/store';
import type { createFilesystem } from '../browser/filesystem';
import { digest, type Plugins } from '../plugins/loader';
import { abortable } from './abortable';
import { conversationKey, type ConversationStore } from './conversation-store';
import { localTools } from './tools';
import type { Attachment, Conversation, InstalledPlugin, StagedAttachment } from './types';

export const attachmentLock = <T>(id: string, work: () => Promise<T>) =>
  globalThis.navigator?.locks ? navigator.locks.request('kinetik-attachments:' + id, work) : work();
const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** Files staged in the composer, uploaded to the active workspace when sent. */
export class Attachments {
  constructor(
    private store: Store,
    private chats: ConversationStore,
    private plugins: Plugins,
    private workspace: ReturnType<typeof createFilesystem>,
  ) {}
  async stage(
    id: string,
    name: string,
    bytes: Uint8Array,
    preview?: Uint8Array,
  ): Promise<StagedAttachment> {
    if (!name || name.length > 255 || /[\/\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name))
      throw new Error('Choose a file with a valid name.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 25 * 1024 * 1024)
      throw new Error('Choose a file smaller than 25 MB.');
    if (
      preview !== undefined &&
      (!(preview instanceof Uint8Array) || preview.byteLength > 2 * 1024 * 1024)
    )
      throw new Error('Invalid file preview.');
    const file = { id: crypto.randomUUID(), name, size: bytes.byteLength };
    await this.store.put('attachment-bytes:' + file.id, bytes);
    // Previews outlive sending: remote providers keep no local copy to show.
    if (preview) await this.store.put('attachment-preview:' + file.id, preview);
    try {
      await this.chats.update(id, (c) => {
        const files = c.attachments ?? [];
        if (
          files.length >= 10 ||
          files.reduce((sum, f) => sum + f.size, file.size) > 25 * 1024 * 1024
        )
          throw new Error('Attach up to 10 files, 25 MB in total.');
        return { ...c, attachments: [...files, file] };
      });
    } catch (error) {
      await this.store.delete('attachment-bytes:' + file.id);
      await this.store.delete('attachment-preview:' + file.id);
      throw error;
    }
    return file;
  }
  preview(attachmentId: string): Promise<Uint8Array | undefined> {
    return this.store.get<Uint8Array>('attachment-preview:' + attachmentId);
  }
  async remove(id: string, attachmentId: string): Promise<void> {
    await attachmentLock(id, async () => {
      let removed = false;
      await this.chats.update(id, (c) => {
        removed = Boolean(c.attachments?.some((f) => f.id === attachmentId));
        return { ...c, attachments: c.attachments?.filter((f) => f.id !== attachmentId) };
      });
      if (removed) {
        await this.store.delete('attachment-bytes:' + attachmentId);
        await this.store.delete('attachment-preview:' + attachmentId);
      }
    });
  }
  async prepare(
    id: string,
    ids: string[],
  ): Promise<{ files: Attachment[]; plugins: InstalledPlugin[] }> {
    const c = await this.store.get<Conversation>(conversationKey(id));
    if (!c || ids.some((id) => !c.attachments?.some((f) => f.id === id)))
      throw new Error('Attachment is no longer available. Add it again.');
    const records = c.plugins ?? (await this.plugins.list());
    const { bindings, sources } = await this.plugins.snapshot(
      localTools(await this.workspace, () => [], this.store),
      records,
    );
    const provider = bindings.write?.provider;
    const source = sources.find((s) => s.installed.manifest.id === provider);
    const upload = source?.plugin.files?.upload;
    if (!provider || (provider !== 'local' && !upload))
      throw new Error(
        'This connection does not support file uploads. Update the connection and try again.',
      );
    const uploadRevision = source
      ? await digest(JSON.stringify([source.installed.digest, source.installed.settings]))
      : 'local';
    const result: Attachment[] = [];
    const signal = AbortSignal.timeout(120000);
    for (const attachmentId of ids) {
      const file = c.attachments!.find((f) => f.id === attachmentId)!;
      if (file.uploaded?.provider === provider && file.uploadRevision === uploadRevision) {
        result.push(file.uploaded);
        continue;
      }
      const bytes = await this.store.get<Uint8Array>('attachment-bytes:' + file.id);
      if (!bytes) throw new Error('Attachment is no longer available. Add it again.');
      let path: string;
      if (provider === 'local') {
        if (bytes.length > 4 * 1024 * 1024)
          throw new Error('Local attachments must be smaller than 4 MB.');
        const fs = (await this.workspace).fs;
        const directory = '/workspace/attachments/' + file.id;
        await fs.mkdir(directory, { recursive: true });
        path = directory + '/' + file.name;
        await fs.writeFile(path, bytes);
      } else {
        ({ path } = await abortable(
          upload!({ id: file.id, name: file.name, bytes }, signal),
          signal,
        ));
        if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f]/.test(path))
          throw new Error('The connection returned an invalid attachment path.');
      }
      const uploaded = { id: file.id, name: file.name, size: file.size, path, provider };
      await this.chats.update(id, (value) => ({
        ...value,
        attachments: value.attachments?.map((f) =>
          f.id === file.id ? { ...f, uploaded, uploadRevision } : f,
        ),
      }));
      result.push(uploaded);
    }
    return { files: result, plugins: records };
  }
  /** Downscaled JPEG previews of photos attached to pending user messages, as data URLs. */
  async images(c: Conversation): Promise<Map<string, string[]>> {
    const images = new Map<string, string[]>();
    for (const id of c.pending) {
      const urls: string[] = [];
      for (const file of c.messages.find((m) => m.id === id)?.attachments ?? []) {
        const preview = await this.store.get<Uint8Array>('attachment-preview:' + file.id);
        if (preview) urls.push('data:image/jpeg;base64,' + base64(preview));
      }
      if (urls.length) images.set(id, urls);
    }
    return images;
  }
}
