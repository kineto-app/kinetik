import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function drawer(page: Page) {
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
}
async function appearance(page: Page, value: string) {
  await drawer(page);
  await page.locator('#settings-open').click();
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption(value);
  await page.getByRole('button', { name: 'Close settings' }).click();
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    })),
  ).toEqual([]);
}

test('appearance follows system, persists offline, and synchronizes tabs', async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await appearance(page, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const other = await context.newPage();
  await other.goto('/');
  await appearance(page, 'dark');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await drawer(page);
  await page.locator('#settings-open').click();
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('dark');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await appearance(page, 'system');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('light and dark workspace, dialogs and messages are accessible', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  for (const theme of ['light', 'dark']) {
    await appearance(page, theme);
    await accessible(page);
    await page.screenshot({ path: info.outputPath(`workspace-${theme}.png`) });
    await drawer(page);
    await page.locator('#settings-open').click();
    await accessible(page);
    await page.screenshot({ path: info.outputPath(`settings-${theme}.png`) });
    await page.getByRole('button', { name: 'Manage connections' }).click();
    await expect(page.getByRole('dialog', { name: 'Connections', exact: true })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: info.outputPath(`plugins-${theme}.png`) });
    await page.getByRole('button', { name: 'Close connections', exact: true }).click();
    await drawer(page);
    await page.locator('#automations-open').click();
    await accessible(page);
    await page.screenshot({ path: info.outputPath(`automations-${theme}.png`) });
    await page.getByRole('button', { name: 'Close routines' }).click();
  }
  await page.getByRole('button', { name: 'Create a note' }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role="assistant"] .message-content')).toContainText(
    'Your note is ready.',
  );
  await accessible(page);
  await page.screenshot({ path: info.outputPath('conversation-dark.png') });
});

test('mobile drawer traps focus and narrow or landscape layouts keep controls reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await drawer(page);
  await expect(page.locator('#menu-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#settings-open')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#menu-close')).toBeFocused();
  await accessible(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu')).toBeFocused();
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const size of [
    { width: 320, height: 740 },
    { width: 375, height: 812 },
    { width: 667, height: 375 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/exec echo reachable');
    await expect(page.locator('#send')).toBeInViewport();
  }
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role="assistant"] .message-content')).toHaveText('reachable\n');
});

test('connections and composer uploads complete their visible workflows', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await drawer(page);
  await page.locator('#connections-open').click();
  await page.getByText('Add a custom connection', { exact: true }).click();
  await page.getByRole('button', { name: 'Use demo connection' }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect(page.locator('#plugin-error')).toContainText('Added.');
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close connections', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/exec from the UI');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role="assistant"] .message-content')).toHaveText(
    'Example plugin received: from the UI',
  );
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add a file', exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: 'example.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('local file'),
  });
  await expect(page.locator('#error')).toHaveText('Added example.txt');
  await expect(page.locator('#files-open')).toHaveCount(0);
  await expect(page.locator('.file-card')).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('/show_file /workspace/example.txt');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .locator('.file-card')
    .getByRole('button', { name: /^Expand / })
    .click();
  await expect(page.locator('#file-preview-text')).toHaveText('local file');
  const downloading = page.waitForEvent('download');
  await page.locator('#file-preview-download').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('example.txt');
  expect(await download.failure()).toBeNull();
});

test('everyday examples explicitly share files that reopen offline', async ({
  page,
  context,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.locator('.empty')).toContainText('sample replies');
  await expect(page.locator('.empty')).not.toContainText('/exec');
  await page.getByRole('button', { name: 'Make a packing list' }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Create a packing list for a weekend away.',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role=assistant]')).toContainText('weekend packing list');
  await expect(page.locator('.tool-details')).toHaveCount(2);
  await expect(page.locator('.tool-details[open]')).toHaveCount(0);
  await expect(page.locator('.file-card')).toContainText('Weekend packing list.txt');
  await page.screenshot({ path: info.outputPath('everyday-chat.png') });
  await page
    .locator('.file-card')
    .getByRole('button', { name: /^Expand / })
    .click();
  await expect(page.locator('#file-preview-text')).toContainText('Toiletries');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await accessible(page);
    await page.screenshot({ path: info.outputPath(`everyday-files-${theme}.png`) });
  }
  const downloadReady = page.waitForEvent('download');
  await page.locator('#file-preview-download').click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe('Weekend packing list.txt');
  expect(await download.failure()).toBeNull();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Ready');
  await page
    .locator('.file-card')
    .getByRole('button', { name: /^Expand / })
    .click();
  await expect(page.locator('#file-preview-text')).toContainText('Toiletries');
});
