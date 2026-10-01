import { rpc } from '../browser/client';
import type { Attachment, StagedAttachment } from '../core/types';
import { download, sizeLabel } from './files';
import { icon } from './icons';
import './attachments.css';

const imageExtensions = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'bmp',
  'heic',
  'heif',
]);
const kinds: Record<string, string> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  txt: 'doc',
  md: 'doc',
  rtf: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  numbers: 'sheet',
};
const extension = (name: string) =>
  name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
const isImageName = (name: string) => imageExtensions.has(extension(name));
const typeLabel = (name: string) => extension(name).slice(0, 4).toUpperCase() || 'FILE';
const previewSize = 1600;

/** A JPEG preview kept beside the attachment. Undecodable images (HEIC in Chromium) stay files. */
export async function makePreview(
  name: string,
  bytes: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (!isImageName(name)) return;
  try {
    const source = await createImageBitmap(new Blob([bytes as BlobPart]), {
      imageOrientation: 'from-image',
    });
    const scale = Math.min(1, previewSize / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d')!;
    // JPEG has no alpha; transparent pixels would otherwise turn black.
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } catch {
    return undefined;
  }
}

const previews = new Map<string, Promise<string | undefined>>();
/** Missing previews (older messages, an older worker) resolve to undefined and show a file card. */
function previewUrl(file: { id: string; name: string }): Promise<string | undefined> {
  if (!isImageName(file.name)) return Promise.resolve(undefined);
  let url = previews.get(file.id);
  if (!url) {
    url = rpc<Uint8Array | null>('attachmentPreview', { attachmentId: file.id })
      .then((bytes) =>
        bytes?.byteLength
          ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
          : undefined,
      )
      .catch(() => undefined);
    previews.set(file.id, url);
  }
  return url;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function iconButton(name: 'close' | 'download' | 'chevron', label: string, className: string) {
  const button = element('button', className);
  button.type = 'button';
  button.innerHTML = icon(name);
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}
function badge(name: string) {
  const node = element('span', 'file-badge', typeLabel(name));
  node.dataset.kind = kinds[extension(name)] ?? 'other';
  node.setAttribute('aria-hidden', 'true');
  return node;
}
function image(url: string, name: string) {
  const img = element('img');
  img.src = url;
  img.alt = name;
  img.decoding = 'async';
  return img;
}

/** Composer tray item: a square thumbnail for photos, a typed tile for other files. */
export function trayItem(file: StagedAttachment, remove: () => void, disabled: boolean) {
  const item = element('div', 'tray-item');
  item.setAttribute('role', 'listitem');
  item.title = file.name;
  const tile = element('span', 'tray-file');
  tile.append(badge(file.name), element('span', 'tray-name', file.name));
  item.append(tile);
  void previewUrl(file).then((url) => {
    if (url) tile.replaceWith(image(url, file.name));
  });
  const button = iconButton('close', 'Remove ' + file.name, 'tray-remove');
  button.disabled = disabled;
  button.onclick = remove;
  item.append(button);
  return item;
}

function fileCard(file: Attachment) {
  const card = element('div', 'attachment-card file-card-tile');
  card.setAttribute('role', 'listitem');
  card.title = file.name;
  const meta = element('span', 'file-meta', `${typeLabel(file.name)} · ${sizeLabel(file.size)}`);
  card.append(badge(file.name), element('span', 'file-name', file.name), meta);
  // Remote providers only accept uploads, so only local workspace files can be fetched back.
  if (file.provider === 'local') {
    const save = iconButton('download', 'Download ' + file.name, 'icon-button card-download');
    save.onclick = () => void saveOriginal(file);
    card.append(save);
  }
  return card;
}
async function saveOriginal(file: Attachment) {
  try {
    download(file, await rpc<Uint8Array>('export', { path: file.path }));
  } catch (error) {
    window.dispatchEvent(new CustomEvent('kinetik-native-error', { detail: error }));
  }
}

/** Sent files as one swipeable row: photos first, then other files. */
export function attachmentCarousel(files: Attachment[]) {
  const row = element('div', 'attachment-carousel');
  row.setAttribute('role', 'list');
  row.setAttribute('aria-label', 'Sent files');
  row.tabIndex = 0;
  const ordered = [...files].sort((a, b) => +isImageName(b.name) - +isImageName(a.name));
  const photos: { file: Attachment; url: string }[] = [];
  for (const file of ordered) {
    if (!isImageName(file.name)) {
      row.append(fileCard(file));
      continue;
    }
    const card = element('div', 'attachment-card photo-card loading');
    card.setAttribute('role', 'listitem');
    row.append(card);
    void previewUrl(file).then((url) => {
      if (!url) return card.replaceWith(fileCard(file));
      const entry = { file, url };
      photos.push(entry);
      photos.sort((a, b) => ordered.indexOf(a.file) - ordered.indexOf(b.file));
      const open = element('button', 'photo-open');
      open.type = 'button';
      open.setAttribute('aria-label', 'Open ' + file.name);
      open.append(image(url, file.name));
      open.onclick = () => openViewer(photos, photos.indexOf(entry), open);
      card.classList.remove('loading');
      card.append(open);
    });
  }
  return row;
}

let viewer: HTMLDialogElement | undefined;
function openViewer(
  photos: { file: Attachment; url: string }[],
  start: number,
  opener: HTMLElement,
) {
  viewer?.remove();
  const dialog = (viewer = element('dialog', 'photo-viewer'));
  dialog.setAttribute('aria-label', 'Photos');
  const head = element('div', 'viewer-head');
  const counter = element('span', 'viewer-counter');
  counter.setAttribute('aria-live', 'polite');
  const save = iconButton('download', 'Download', 'icon-button');
  const close = iconButton('close', 'Close photos', 'icon-button');
  close.onclick = () => dialog.close();
  head.append(counter, save, close);
  const track = element('div', 'viewer-track');
  track.tabIndex = 0;
  track.setAttribute('role', 'group');
  track.setAttribute('aria-roledescription', 'carousel');
  track.setAttribute('aria-label', 'Photos');
  for (const { file, url } of photos) {
    const figure = element('figure');
    figure.append(image(url, file.name));
    track.append(figure);
  }
  const previous = iconButton('chevron', 'Previous photo', 'viewer-step previous');
  const next = iconButton('chevron', 'Next photo', 'viewer-step next');
  dialog.append(head, track, previous, next);
  let index = start;
  // Fractional widths: rounded clientWidth leaves a sliver of the neighbouring photo.
  const width = () => track.getBoundingClientRect().width;
  const show = (value: number, behavior: ScrollBehavior = 'smooth') => {
    index = Math.max(0, Math.min(photos.length - 1, value));
    track.scrollTo({ left: index * width(), behavior });
    sync();
  };
  const sync = () => {
    const file = photos[index].file;
    counter.textContent = photos.length > 1 ? `${index + 1} / ${photos.length}` : file.name;
    save.hidden = file.provider !== 'local';
    save.setAttribute('aria-label', 'Download ' + file.name);
    previous.disabled = index === 0;
    next.disabled = index === photos.length - 1;
    previous.hidden = next.hidden = photos.length < 2;
  };
  track.addEventListener('scroll', () => {
    const settled = Math.round(track.scrollLeft / Math.max(1, width()));
    if (settled !== index) {
      index = settled;
      sync();
    }
  });
  previous.onclick = () => show(index - 1);
  next.onclick = () => show(index + 1);
  save.onclick = () => void saveOriginal(photos[index].file);
  dialog.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    show(index + step);
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (viewer === dialog) viewer = undefined;
    opener.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  show(start, 'instant');
  close.focus();
}
