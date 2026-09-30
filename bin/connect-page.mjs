import { readFile } from 'node:fs/promises';

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );

// A view for a credential helper. This module does not implement or enable authentication.
export async function renderConnectPage({ appStyles, themeScript, uiBase, apiBase, appUrl }) {
  const template = await readFile(new URL('./ui/connect.html', import.meta.url), 'utf8');
  const values = { appStyles, themeScript, uiBase, apiBase, appUrl };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => escape(values[key]));
}
