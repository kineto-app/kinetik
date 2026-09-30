import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';

const key = 'test-invoke-key';
const script = readFileSync('src-tauri/src/android-ipc.js', 'utf8').replace(
  '__INVOKE_KEY__',
  JSON.stringify(key),
);

test('Android IPC is initialized only in the top frame and does not expose its invoke key', () => {
  const child = { top: {}, __TAURI_INTERNALS__: {} };
  runInNewContext(script, { window: child });
  expect(child.__TAURI_INTERNALS__).not.toHaveProperty('postMessage');
  const calls: string[] = [];
  const main: any = {
    location: { origin: 'https://tauri.localhost' },
    __TAURI_INTERNALS__: {},
    kinetikIPC: { postMessage: (message: string) => calls.push(message) },
  };
  main.top = main;
  runInNewContext(script, { window: main, Uint8Array, ArrayBuffer, Map });
  expect(String(main.__TAURI_INTERNALS__.postMessage)).not.toContain(key);
  main.__TAURI_INTERNALS__.postMessage({
    cmd: 'file',
    callback: 1,
    error: 2,
    payload: new Uint8Array([0, 255]),
  });
  expect(JSON.parse(calls[0])).toEqual({
    cmd: 'file',
    callback: 1,
    error: 2,
    payload: [0, 255],
    options: { customProtocolIpcBlocked: true },
    __TAURI_INVOKE_KEY__: key,
  });
});
