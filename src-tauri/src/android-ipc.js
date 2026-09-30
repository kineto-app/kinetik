// Android's WebView injects Wry 0.57 initialization scripts into child frames.
// Keep the invoke key in a closure created only for the trusted top-level page.
// The native WebMessageListener independently checks origin AND isMainFrame.
(() => {
  if (window !== window.top || window.location.origin !== 'https://tauri.localhost') return;
  const invokeKey = __INVOKE_KEY__;
  Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage', {
    value: ({ cmd, callback, error, payload, options }) => {
      const message = JSON.stringify(
        {
          cmd,
          callback,
          error,
          payload,
          options: { ...options, customProtocolIpcBlocked: true },
          __TAURI_INVOKE_KEY__: invokeKey,
        },
        (_key, value) => {
          // Tauri's IPC serialization convention, including binary file/HTTP data.
          if (value instanceof Map) return Object.fromEntries(value);
          if (value instanceof Uint8Array) return Array.from(value);
          if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
          if (value && typeof value === 'object' && '__TAURI_TO_IPC_KEY__' in value)
            return value.__TAURI_TO_IPC_KEY__();
          return value;
        },
      );
      window.kinetikIPC.postMessage(message);
    },
  });
})();
