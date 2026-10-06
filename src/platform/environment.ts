/** True only inside the trusted native app webview. */
export const isNative = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The platform a request comes from. An installed web app counts as `web`. */
export type ClientPlatform = 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux';
const platforms: readonly string[] = ['web', 'ios', 'android', 'macos', 'windows', 'linux'];
let platform: ClientPlatform = 'web';
export const clientPlatform = () => platform;
/** Native startup records the operating system before the runtime starts. */
export function setClientPlatform(value: string) {
  if (platforms.includes(value)) platform = value as ClientPlatform;
}
/** For native shells that cannot report their operating system. */
export function guessNativePlatform(userAgent: string): ClientPlatform {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (/Mac/.test(userAgent)) return 'macos';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'linux';
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
export function capabilities(value: ClientPlatform = platform): Capabilities {
  return {
    linkPlugins: value !== 'ios',
    routinesNeedOpenApp: value === 'ios' || value === 'web',
    continuesAfterLeaving: value === 'android',
    notifications: value === 'web' || value === 'android',
  };
}
