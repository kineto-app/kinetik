import { afterEach, expect, test, vi } from 'vitest';
import { waitForNativeBridge } from '../src/platform/ready';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ready = () => ({
  invoke() {},
  transformCallback() {},
  metadata: { currentWindow: { label: 'main' } },
});

test('starts immediately when native IPC is already initialized', async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: ready() });
  await expect(waitForNativeBridge()).resolves.toBeUndefined();
});

test('waits for late native initialization instead of starting in browser mode', async () => {
  vi.useFakeTimers();
  const target: { __TAURI_INTERNALS__?: ReturnType<typeof ready> } = {};
  vi.stubGlobal('window', target);
  let started = false;
  const waiting = waitForNativeBridge().then(() => {
    started = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(started).toBe(false);
  target.__TAURI_INTERNALS__ = ready();
  await vi.advanceTimersByTimeAsync(25);
  await waiting;
  expect(started).toBe(true);
});

test('a partial bridge does not start the application', async () => {
  vi.useFakeTimers();
  const target = { __TAURI_INTERNALS__: { invoke() {} } };
  vi.stubGlobal('window', target);
  let started = false;
  const waiting = waitForNativeBridge().then(() => {
    started = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(started).toBe(false);
  target.__TAURI_INTERNALS__ = ready();
  await vi.advanceTimersByTimeAsync(25);
  await waiting;
  expect(started).toBe(true);
});

test('a missing bridge fails explicitly after the startup deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {});
  const waiting = expect(waitForNativeBridge(100)).rejects.toThrow(
    'Native bridge did not initialize',
  );
  await vi.advanceTimersByTimeAsync(100);
  await waiting;
});
