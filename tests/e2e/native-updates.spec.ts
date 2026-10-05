import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

let script: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['src/platform/updates.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'nativeUpdatesFixture',
    platform: 'browser',
    alias: { 'node:zlib': resolve('src/browser/no-zlib.ts') },
    define: { __NATIVE_CONFIG__: '{"connections":{}}' },
  });
  script = result.outputFiles[0].text + '\nwindow.nativeUpdatesFixture = nativeUpdatesFixture;';
});
test('native updates show a silent restart pill and one healthy-start toast', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.evaluate(() => {
    const fixture = window as unknown as { __TAURI_INTERNALS__: unknown; updateCalls: string[] };
    fixture.updateCalls = [];
    fixture.__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        fixture.updateCalls.push(command);
        if (command === 'updates_ready') return true;
        return {
          enabled: true,
          healthConfigured: false,
          reportsEnabled: true,
          staged: '1.1.0',
          snapshotNeeded: false,
          restart: true,
        };
      },
    };
  });
  await page.evaluate(script);
  await page.evaluate(() =>
    (
      window as unknown as { nativeUpdatesFixture: { setupNativeUpdates(): Promise<void> } }
    ).nativeUpdatesFixture.setupNativeUpdates(),
  );
  await expect(page.locator('#app-update')).toContainText('Restart to update');
  await expect(page.locator('#app-update-apply')).toBeHidden();
  await expect(page.locator('#toasts')).toContainText('Kinetik was updated');
  expect(
    await page.evaluate(() => (window as unknown as { updateCalls: string[] }).updateCalls),
  ).toContain('updates_check');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`native-update-${theme}.png`) });
  }
  await page
    .locator('#settings-dialog')
    .evaluate((dialog: HTMLDialogElement) => dialog.showModal());
  await expect(page.locator('#settings-dialog #app-update')).toBeVisible();
});
test('native staged updates remain silent before their restart threshold', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.evaluate(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) =>
        command === 'updates_ready'
          ? false
          : {
              enabled: true,
              healthConfigured: false,
              reportsEnabled: true,
              staged: '1.1.0',
              snapshotNeeded: false,
              restart: false,
            },
    };
  });
  await page.evaluate(script);
  await page.evaluate(() =>
    (
      window as unknown as { nativeUpdatesFixture: { setupNativeUpdates(): Promise<void> } }
    ).nativeUpdatesFixture.setupNativeUpdates(),
  );
  await expect(page.locator('#app-update')).toBeHidden();
  await expect(page.locator('#toasts')).toBeEmpty();
});
