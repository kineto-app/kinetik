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

/** Long addresses fail silently in some mail apps, so a long reply is shortened. */
const replyLimit = 1500;
export function reportEmail(to: string, reply: string) {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
  const text =
    reply.length > replyLimit ? reply.slice(0, replyLimit) + '\n[Reply shortened]' : reply;
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
}
