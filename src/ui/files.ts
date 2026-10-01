import { isNative } from '../platform/environment';
import { rpc } from '../browser/client';
import type { Message } from '../core/types';
import { icon, type IconName } from './icons';
import { copyButton, renderMessageContent } from './message-content';
import './files.css';

type SharedFile = NonNullable<Message['file']>;
const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};
const textTypes = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'log']);
const extension = (file: SharedFile) => file.name.split('.').at(-1)!.toLowerCase();
const textLimit = 32000;
export const filesDialog = `
<input type="file" id="upload" hidden multiple aria-label="Add files" />
<dialog id="file-dialog" aria-labelledby="file-preview-name"><div id="file-view"></div></dialog>`;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readFile = (file: SharedFile) =>
  file.snapshotId
    ? rpc<Uint8Array>('export-shared', { id: file.snapshotId })
    : rpc<Uint8Array>('export', { path: file.path });
function control(name: IconName, label: string, action: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.innerHTML = icon(name);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.onclick = action;
  return button;
}
export function download(file: SharedFile, bytes: Uint8Array) {
  if (isNative) {
    void import('../platform/files')
      .then(({ saveNativeFile }) => saveNativeFile(file.name, bytes))
      .catch((error) =>
        window.dispatchEvent(new CustomEvent('kinetik-native-error', { detail: error })),
      );
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function sizeLabel(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render only inert text/Markdown and raster images. Other formats remain downloadable files. */
function fileContent(file: SharedFile, bytes: Uint8Array) {
  const body = document.createElement('div');
  body.className = 'shared-file-body';
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', file.name);
  const ext = extension(file);
  let url: string | undefined;
  if (textTypes.has(ext)) {
    const text = new TextDecoder().decode(bytes.slice(0, textLimit));
    if (ext === 'md' || ext === 'markdown') body.append(renderMessageContent(text));
    else {
      const pre = document.createElement('pre');
      pre.textContent = text;
      body.append(pre);
    }
    if (bytes.length > textLimit) {
      const note = document.createElement('p');
      note.className = 'field-hint';
      note.textContent = 'Preview shortened. Download for the full file.';
      body.append(note);
    }
  } else if (imageTypes[ext]) {
    const img = document.createElement('img');
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageTypes[ext] }));
    img.src = url;
    img.alt = file.name;
    img.onerror = () => {
      body.textContent = 'Preview unavailable. You can still download the file.';
    };
    body.append(img);
  } else {
    body.textContent = `${ext.toUpperCase()} · ${sizeLabel(bytes.length)}`;
  }
  return {
    body,
    dispose: () => {
      if (url) URL.revokeObjectURL(url);
    },
  };
}
let closePreview: (() => void) | undefined;
function showPreview(file: SharedFile, bytes: Uint8Array) {
  closePreview?.();
  const dialog = byId<HTMLDialogElement>('file-dialog');
  const { panel, dispose } = filePanel(file, bytes, true);
  byId('file-view').replaceChildren(panel);
  closePreview = dispose;
  dialog.showModal();
}
function filePanel(file: SharedFile, bytes: Uint8Array, expanded = false) {
  const panel = document.createElement('section');
  panel.className = 'shared-file-panel';
  const header = document.createElement('header');
  header.className = 'shared-file-head';
  const title = document.createElement('strong');
  title.textContent = file.name;
  title.title = file.name;
  if (expanded) title.id = 'file-preview-name';
  header.append(title);
  if (textTypes.has(extension(file))) {
    const copy = copyButton(new TextDecoder().decode(bytes), 'Copy file', true);
    copy.classList.add('icon-button');
    header.append(copy);
  }
  const save = control('download', 'Download ' + file.name, () => download(file, bytes));
  if (expanded) save.id = 'file-preview-download';
  header.append(
    save,
    expanded
      ? control('close', 'Close file', () => byId<HTMLDialogElement>('file-dialog').close())
      : control('expand', 'Expand ' + file.name, () => showPreview(file, bytes)),
  );
  const { body, dispose } = fileContent(file, bytes);
  if (expanded) body.id = 'file-preview-text';
  else {
    const image = body.querySelector('img');
    if (image) {
      const open = control('expand', 'Expand ' + file.name, () => showPreview(file, bytes));
      open.className = 'shared-file-image';
      image.replaceWith(open);
      open.replaceChildren(image);
    }
  }
  panel.append(header, body);
  return { panel, dispose };
}

export function mountFile(target: HTMLElement, file: SharedFile, changed: () => void) {
  const card = document.createElement('div');
  card.className = 'file-card';
  target.append(card);
  let disposed = false;
  let disposeContent = () => {};
  const load = async () => {
    card.textContent = 'Loading ' + file.name + '…';
    card.setAttribute('aria-busy', 'true');
    try {
      const bytes = await readFile(file);
      if (disposed) return;
      const timeline = card.closest<HTMLElement>('#timeline');
      const follow =
        timeline && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
      card.replaceChildren();
      if (textTypes.has(extension(file)) || imageTypes[extension(file)]) {
        const rendered = filePanel(file, bytes);
        disposeContent = rendered.dispose;
        card.append(rendered.panel);
      } else {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'shared-file-row';
        row.setAttribute('aria-label', 'Open ' + file.name);
        row.innerHTML = `<span class="glyph">${icon('file')}</span><span class="shared-file-info"><strong></strong><small></small></span>${icon('openArrow')}`;
        row.querySelector('strong')!.textContent = file.name;
        row.querySelector('small')!.textContent =
          `${extension(file).toUpperCase()} · ${sizeLabel(bytes.length)}`;
        row.onclick = () => showPreview(file, bytes);
        card.append(row);
      }
      card.removeAttribute('aria-busy');
      if (follow) timeline.scrollTop = timeline.scrollHeight;
      changed();
    } catch (error) {
      if (disposed) return;
      card.removeAttribute('aria-busy');
      const name = document.createElement('strong');
      name.textContent = file.name;
      const note = document.createElement('p');
      note.className = 'field-hint';
      note.textContent = 'File unavailable. Try again.';
      note.title = error instanceof Error ? error.message : String(error);
      card.replaceChildren(
        name,
        note,
        control('refresh', 'Retry file', () => {
          void load();
        }),
      );
      changed();
    }
  };
  void load();
  return () => {
    disposed = true;
    disposeContent();
  };
}
function showFeedback(value: unknown, kind: string) {
  byId('error').textContent = value instanceof Error ? value.message : String(value);
  byId('error').dataset.kind = kind;
}
export function setupFiles(attach: (file: { name: string; bytes: Uint8Array }) => Promise<void>) {
  byId('file-dialog').addEventListener('close', () => {
    closePreview?.();
    closePreview = undefined;
    byId('file-view').replaceChildren();
  });
  byId('upload').onchange = () => {
    void (async () => {
      const input = byId<HTMLInputElement>('upload');
      const files = [...(input.files ?? [])];
      input.value = '';
      // One at a time keeps the chosen order and stops at the first file over the limits.
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) throw new Error('Choose a file smaller than 25 MB.');
        await attach({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      if (files.length)
        byId('ui-announcement').textContent =
          files.length === 1 ? 'Attached ' + files[0].name : `Attached ${files.length} files`;
    })().catch((error) => showFeedback(error, 'error'));
  };
}
