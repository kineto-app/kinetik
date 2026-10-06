import { createSignal } from 'solid-js';
import type { AppDetails } from '../connections/config';
import { clientPlatform, isNative } from '../platform/environment';

declare const __APP_VERSION__: string | undefined;
/** The distributor's links and contacts from the connection configuration. */
export const [appDetails, setAppDetails] = createSignal<AppDetails>({});

/** A link outside the app: the system browser or mail app on devices, a new tab on the web. */
export async function openExternal(url: string) {
  if (isNative) await (await import('@tauri-apps/plugin-opener')).openUrl(url);
  else if (url.startsWith('mailto:')) location.href = url;
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** Mail apps silently drop long addresses, so the whole encoded address stays under this. */
export const mailtoLimit = 2000;
const shortened = '\n[Reply shortened]';
export function reportEmail(to: string, reply: string) {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
  const address = (text: string) => {
    const body = [
      'What is wrong with this reply?',
      '',
      '',
      '--- Reply ---',
      text,
      '',
      `--- Kinetik ${version} (${clientPlatform()}) ---`,
    ].join('\n');
    return `mailto:${to}?${new URLSearchParams({ subject: 'Report a reply', body })
      .toString()
      .replaceAll('+', '%20')}`;
  };
  const full = address(reply);
  if (full.length <= mailtoLimit) return full;
  // Cut whole code points, so a character outside ASCII is never split in half.
  const points = Array.from(reply);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (address(points.slice(0, middle).join('') + shortened).length <= mailtoLimit) low = middle;
    else high = middle - 1;
  }
  return address(points.slice(0, low).join('') + shortened);
}
