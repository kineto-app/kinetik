import { rpc } from '../browser/client';
import { icon } from './icons';

export const filesDialog = `
<dialog id="files-dialog" aria-labelledby="files-heading" aria-describedby="files-description">
  <div class="dialog-head"><span class="glyph">${icon('folder')}</span><div><h2 id="files-heading">Files</h2><p id="files-description" class="small muted">Saved in this browser, ready when you need them.</p></div><button data-close="files-dialog" class="icon-button" aria-label="Close files">${icon('close')}</button></div>
  <div class="upload-zone"><input type="file" id="upload" class="sr-only" aria-describedby="upload-hint" /><label for="upload" class="upload-pick">${icon('upload')}<span>Add a file</span></label><p id="upload-hint" class="field-hint">Choose a file from your device, up to 4 MB.</p></div>
  <div id="file-list" class="file-list" aria-live="polite"></div>
  <section id="file-preview" class="file-preview" hidden><div class="file-preview-heading"><h3 id="file-preview-name"></h3><button id="file-preview-download" class="secondary">${icon('download')}Download</button></div><pre id="file-preview-text"></pre></section>
  <p id="file-result" class="feedback" role="status"></p>
  <details class="advanced"><summary>Advanced file access</summary><form id="download-form"><label for="download-path">Workspace path</label><div class="download-row"><input id="download-path" value="/workspace/note.txt" required spellcheck="false" /><button class="secondary">Download by path</button></div></form></details>
</dialog>`;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let previewPath = '';
let previewGeneration = 0;
export async function downloadFile(path: string) {
  const bytes = await rpc<Uint8Array>('export', { path });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = document.createElement('a');
  link.href = url;
  link.download = path.split('/').pop() || 'download';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function previewFile(path: string) {
  const generation = ++previewGeneration;
  const bytes = await rpc<Uint8Array>('export', { path });
  if (generation !== previewGeneration) return;
  previewPath = path;
  byId('file-preview-name').textContent = path.split('/').at(-1)!;
  byId('file-preview-text').textContent = /\.(txt|md|csv|json|ya?ml|log)$/i.test(path)
    ? new TextDecoder().decode(bytes.slice(0, 32000)) +
      (bytes.length > 32000 ? '\n\nDownload the file to see the rest.' : '')
    : 'Download this file to open it on your device.';
  byId('file-preview').hidden = false;
  byId('file-preview').scrollIntoView({ block: 'nearest' });
}
export async function refreshFiles() {
  const files = await rpc<{ path: string; name: string; size: number }[]>('files');
  const list = byId('file-list');
  list.replaceChildren();
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No files yet. Add one above or try creating a note in chat.';
    list.append(empty);
  }
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const open = document.createElement('button');
    open.className = 'file-open';
    open.innerHTML = icon('file');
    const label = document.createElement('span');
    label.textContent = file.path.slice('/workspace/'.length);
    open.append(label);
    open.onclick = () => {
      void previewFile(file.path).catch(showError);
    };
    const download = document.createElement('button');
    download.className = 'icon-button';
    download.innerHTML = icon('download');
    download.setAttribute('aria-label', 'Download ' + file.name);
    download.title = 'Download ' + file.name;
    download.onclick = () => {
      void downloadFile(file.path).catch(showError);
    };
    const size = document.createElement('span');
    size.className = 'small muted';
    size.textContent = file.size < 1024 ? file.size + ' B' : Math.ceil(file.size / 1024) + ' KB';
    row.append(open, size, download);
    list.append(row);
  }
}
function showError(error: unknown) {
  byId('file-result').textContent = error instanceof Error ? error.message : String(error);
  byId('file-result').dataset.kind = 'error';
}
export function setupFiles() {
  byId('upload').onchange = () => {
    void (async () => {
      const file = byId<HTMLInputElement>('upload').files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) throw new Error('Choose a file smaller than 4 MB.');
      await rpc('import', { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      byId('file-result').textContent = 'Added ' + file.name;
      byId('file-result').dataset.kind = 'success';
      byId<HTMLInputElement>('upload').value = '';
      await refreshFiles();
    })().catch(showError);
  };
  byId('file-preview-download').onclick = () => {
    void downloadFile(previewPath).catch(showError);
  };
  byId('download-form').onsubmit = (event) => {
    event.preventDefault();
    void downloadFile(byId<HTMLInputElement>('download-path').value).catch(showError);
  };
}
