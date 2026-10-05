import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

let script: string;
let recoveryScript: string;
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
  const recovery = await build({
    entryPoints: ['src/platform/native.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'nativeRecoveryFixture',
    platform: 'browser',
    alias: { 'node:zlib': resolve('src/browser/no-zlib.ts') },
    define: { __NATIVE_CONFIG__: '{"connections":{}}' },
  });
  recoveryScript =
    recovery.outputFiles[0].text + '\nwindow.nativeRecoveryFixture = nativeRecoveryFixture;';
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

test('embedded recovery retries offline checks and stages a replacement without opening the workspace', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.evaluate(() => {
    const fixture = window as unknown as {
      __TAURI_INTERNALS__: unknown;
      recoveryCalls: string[];
      recoveryOpens: number;
    };
    fixture.recoveryCalls = [];
    fixture.recoveryOpens = 0;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
      fixture.recoveryOpens++;
      return open(...args);
    };
    let checks = 0;
    const state = {
      enabled: true,
      recovery:
        'Kinetik needs a compatible update before opening your workspace. Your data has been kept.',
      healthConfigured: false,
      reportsEnabled: false,
      staged: null as string | null,
      snapshotNeeded: false,
      restart: false,
    };
    fixture.__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        fixture.recoveryCalls.push(command);
        if (command === 'updates_status') return state;
        if (command !== 'updates_check') throw new Error('Unexpected workspace call');
        checks++;
        if (checks === 1) throw new Error('offline');
        // The next feed after staging revokes the replacement, so recovery must keep checking.
        return { ...state, staged: checks === 2 ? '2.2.0' : null, restart: checks === 2 };
      },
    };
  });
  await page.clock.install();
  await page.evaluate(recoveryScript);
  await page.evaluate(() =>
    (
      window as unknown as { nativeRecoveryFixture: { connectNative(): Promise<void> } }
    ).nativeRecoveryFixture
      .connectNative()
      .catch(() => {}),
  );
  const recovery = page.getByRole('dialog', { name: 'Kinetik recovery' });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('alert')).toContainText('Could not check');
  await recovery.getByRole('button', { name: 'Check for update' }).click();
  await expect(recovery.getByRole('status')).toContainText(
    'Update 2.2.0 is ready. Close Kinetik completely, then reopen it',
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`native-recovery-${theme}.png`) });
  }
  await page.keyboard.press('Escape');
  await expect(recovery).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(recovery.getByRole('status')).toContainText('No compatible update is ready');
  const observed = await page.evaluate(() => {
    const fixture = window as unknown as { recoveryCalls: string[]; recoveryOpens: number };
    return { calls: fixture.recoveryCalls, opens: fixture.recoveryOpens };
  });
  expect(observed.opens).toBe(0);
  expect(observed.calls).toEqual([
    'updates_status',
    'updates_check',
    'updates_check',
    'updates_check',
  ]);
});
