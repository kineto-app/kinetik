/** True only inside the trusted native app webview. */
export const isNative = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The platform a request comes from. An installed web app counts as `web`. */
export type ClientPlatform = 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux';
const platforms: readonly string[] = ['web', 'ios', 'android', 'macos', 'windows', 'linux'];
/** `unknown`: a native app that could not tell its operating system. */
let platform: ClientPlatform | 'unknown' = 'web';
export const clientPlatform = () => platform;
/** Native startup records the operating system before the runtime starts. */
export function setClientPlatform(value: string) {
  platform = platforms.includes(value) ? (value as ClientPlatform) : 'unknown';
}
/**
 * For native shells that cannot report their operating system. An iPad's webview presents
 * itself as a Mac, so a Mac user agent stays unknown.
 */
export function guessNativePlatform(userAgent: string): ClientPlatform | 'unknown' {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (/Windows/.test(userAgent)) return 'windows';
  if (/Linux/.test(userAgent)) return 'linux';
  return 'unknown';
}

/** What a platform allows. Features branch on these, never on the platform name. */
export interface Capabilities {
  /** Plugins can be added from a link. Otherwise only plugins that come with the app run. */
  linkPlugins: boolean;
  /**
   * The system suspends the app soon after it leaves the screen, so routines run only while
   * Kinetik is open.
   */
  routinesNeedOpenApp: boolean;
  /**
   * Work the user started keeps going for a while after they leave the app: a foreground
   * service on Android. Elsewhere work resumes when the user returns.
   */
  continuesAfterLeaving: boolean;
  /** The app can alert the user when work finishes while it is in the background. */
  notifications: boolean;
}
/** An unknown platform gets the most restrictive answer to every question. */
export function capabilities(value: ClientPlatform | 'unknown' = platform): Capabilities {
  return {
    linkPlugins: value !== 'ios' && value !== 'unknown',
    routinesNeedOpenApp: value === 'ios' || value === 'web' || value === 'unknown',
    continuesAfterLeaving: value === 'android',
    notifications: value === 'web' || value === 'android',
  };
}
