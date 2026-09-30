import { rpc } from '../browser/client';
import type { Message } from '../core/types';
import { icon } from './icons';

type SharedFile = NonNullable<Message['file']>;
export const filesDialog = `
<input type="file" id="upload" hidden aria-label="Add a file" />
<dialog id="file-dialog" aria-labelledby="file-preview-name">
  <div class="dialog-head"><span class="glyph">${icon('file')}</span><h2 id="file-preview-name">File</h2><button data-close="file-dialog" class="icon-button" aria-label="Close file">${icon('close')}</button></div>
  <section class="file-preview"><pre id="file-preview-text"></pre></section>
  <p id="file-result" class="feedback" role="status"></p>
  <button id="file-preview-download" class="secondary">${icon('download')}Download</button>
</dialog>`;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let preview: SharedFile | undefined;
let previewGeneration = 0;
const readFile = (file: SharedFile) =>
  file.snapshotId
    ? rpc<Uint8Array>('export-shared', { id: file.snapshotId })
    : rpc<Uint8Array>('export', { path: file.path });
export async function downloadFile(file: SharedFile) {
  const bytes = await readFile(file);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function previewFile(file: SharedFile) {
  const generation = ++previewGeneration;
  preview = undefined;
  byId<HTMLButtonElement>('file-preview-download').disabled = true;
  byId('file-preview-name').textContent = file.name;
  byId('file-preview-text').textContent = 'Loading…';
  byId('file-result').textContent = '';
  try {
    const bytes = await readFile(file);
    if (generation !== previewGeneration) return;
    preview = file;
    byId('file-preview-text').textContent = /\.(txt|md|csv|json|ya?ml|log)$/i.test(file.name)
      ? new TextDecoder().decode(bytes.slice(0, 32000)) +
        (bytes.length > 32000 ? '\n\nDownload the file to see the rest.' : '')
      : 'Download this file to open it on your device.';
    byId<HTMLButtonElement>('file-preview-download').disabled = false;
  } catch (error) {
    if (generation !== previewGeneration) return;
    byId('file-preview-text').textContent = '';
    showFeedback(error, 'file-result', 'error');
  }
}
function showFeedback(value: unknown, target: string, kind: string) {
  byId(target).textContent = value instanceof Error ? value.message : String(value);
  byId(target).dataset.kind = kind;
}
export function setupFiles() {
  byId('upload').onchange = () => {
    void (async () => {
      const input = byId<HTMLInputElement>('upload');
      const file = input.files?.[0];
      if (!file) return;
      input.value = '';
      if (file.size > 4 * 1024 * 1024) throw new Error('Choose a file smaller than 4 MB.');
      await rpc('import', { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      showFeedback('Added ' + file.name, 'error', 'success');
    })().catch((error) => showFeedback(error, 'error', 'error'));
  };
  byId('file-preview-download').onclick = () => {
    if (preview)
      void downloadFile(preview).catch((error) => showFeedback(error, 'file-result', 'error'));
  };
}
