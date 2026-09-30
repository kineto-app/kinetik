import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('workspace export/import restores chats and files through Settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('/exec echo preserved > /workspace/export-test; cat /workspace/export-test');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role=assistant]').last()).toContainText('preserved');
  if (await page.getByRole('button', { name: 'Toggle chats', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Toggle chats', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.locator('#archive-export').click();
  const saved = await download;
  const archive = await readFile((await saved.path())!);
  expect(JSON.parse(archive.toString()).format).toBe('kinetik-workspace');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .locator('#archive-file')
    .setInputFiles({ name: 'workspace.json', mimeType: 'application/json', buffer: archive });
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('/read /workspace/export-test');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role=assistant]').last()).toContainText('preserved');
});
