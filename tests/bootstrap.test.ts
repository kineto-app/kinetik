import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

async function bundle(native: boolean) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/bootstrap.ts'],
    bundle: true,
    format: 'iife',
    write: false,
    define: { __NATIVE_BUILD__: String(native) },
    plugins: [
      {
        name: 'observe-application-start',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/main$/ }, () => ({ path: 'main', namespace: 'test' }));
          builder.onLoad({ filter: /^main$/, namespace: 'test' }, () => ({
            contents: `import { isNative } from './src/platform/environment'; globalThis.bootstrapMode = isNative ? 'native' : 'browser';`,
            resolveDir: root,
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

test('native bundle defers importing the application until late bridge initialization', async () => {
  const code = await bundle(true);
  vi.useFakeTimers();
  const window: Record<string, unknown> = {};
  const context = { window, setTimeout, Date, bootstrapMode: undefined };
  runInNewContext(code, context);
  await vi.advanceTimersByTimeAsync(100);
  expect(context.bootstrapMode).toBeUndefined();
  window.__TAURI_INTERNALS__ = {
    invoke() {},
    transformCallback() {},
    metadata: { currentWindow: { label: 'main' } },
  };
  await vi.advanceTimersByTimeAsync(25);
  expect(context.bootstrapMode).toBe('native');
});

test('browser bundle starts without a native bridge or startup delay', async () => {
  const code = await bundle(false);
  vi.useFakeTimers();
  const context = { window: {}, setTimeout, Date, bootstrapMode: undefined };
  runInNewContext(code, context);
  await vi.advanceTimersByTimeAsync(0);
  expect(context.bootstrapMode).toBe('browser');
  expect(vi.getTimerCount()).toBe(0);
});
