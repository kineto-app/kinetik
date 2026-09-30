/** True only inside the trusted native app webview. */
export const isNative = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
