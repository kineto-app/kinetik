import { rpc } from '../browser/client';
import { isNative } from '../platform/environment';

export function setupDataTransfer() {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const status = byId('archive-status');
  const buttons = [
    byId<HTMLButtonElement>('archive-export'),
    byId<HTMLButtonElement>('archive-import'),
  ];
  async function run(work: () => Promise<void>) {
    buttons.forEach((button) => {
      button.disabled = true;
    });
    status.textContent = 'Preparing data…';
    try {
      await work();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  }
  buttons[0].onclick = () =>
    void run(async () => {
      const text = await rpc<string>('archiveExport');
      const name = 'kinetik-workspace.json';
      if (isNative)
        await (
          await import('../platform/files')
        ).saveNativeFile(name, new TextEncoder().encode(text));
      else {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      status.textContent = 'Export ready. Keep it private; it contains your chats and files.';
    });
  async function restore(text: string) {
    if (
      !confirm(
        'Replace the chats, local files, and routines on this device with this export? Your sign-ins stay on this device. Imported connections need to be enabled again.',
      )
    ) {
      status.textContent = '';
      return;
    }
    await rpc('archiveImport', { text });
    sessionStorage.removeItem('kinetik-conversation');
    location.reload();
  }
  buttons[1].onclick = () => {
    if (!isNative) {
      byId<HTMLInputElement>('archive-file').click();
      return;
    }
    void run(async () => {
      const file = await (await import('../platform/files')).importNativeFile();
      if (file) await restore(new TextDecoder().decode(file.bytes));
      else status.textContent = '';
    });
  };
  byId<HTMLInputElement>('archive-file').onchange = (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void run(async () => {
      if (file.size > 32 * 1024 * 1024) throw new Error('Choose an export smaller than 32 MB.');
      await restore(await file.text());
    });
  };
}
