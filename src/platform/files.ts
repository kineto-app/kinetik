import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { open as openFile, writeFile } from '@tauri-apps/plugin-fs';

export async function importNativeFile(): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  const path = await open({ multiple: false, directory: false, title: 'Add a file' });
  if (!path) return;
  let name = path.split(/[\\/]/).at(-1) || 'file';
  if (path.startsWith('content:')) {
    const result = await invoke<{ value: string }>('plugin:native|file_info', {
      payload: { url: path },
    });
    const info = JSON.parse(result.value) as { name?: string; size?: number };
    name = info.name || 'file';
    if (info.size && info.size > 32 * 1024 * 1024)
      throw new Error('Choose a file smaller than 32 MB.');
  }
  const file = await openFile(path, { read: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = new Uint8Array(64 * 1024);
      const count = await file.read(chunk);
      if (!count) break;
      size += count;
      if (size > 32 * 1024 * 1024) throw new Error('Choose a file smaller than 32 MB.');
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    await file.close();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { name, bytes };
}
export async function saveNativeFile(name: string, bytes: Uint8Array): Promise<void> {
  const path = await save({ defaultPath: name, title: 'Save file' });
  if (path) await writeFile(path, bytes);
}
