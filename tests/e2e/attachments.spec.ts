import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { rpc, attachmentPath } from './rpc';

test('Enter adds a newline and only Send submits the message', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('First line');
  await input.press('Enter');
  await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  await expect(page.locator('[data-role=user]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role=user] .message-content')).toHaveText(
    'First line\nSecond line',
  );
});

test('attachments survive reload, can be removed, and can be sent without text', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.locator('#upload').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Remember the tickets.'),
  });
  await expect(page.locator('#attachments')).toContainText('notes.txt');
  await page.reload();
  await expect(page.locator('#attachments')).toContainText('notes.txt');
  await page.locator('#upload').setInputFiles({
    name: 'remove.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Remove me'),
  });
  await page.getByRole('button', { name: 'Remove remove.txt', exact: true }).click();
  await expect(page.locator('#attachments')).not.toContainText('remove.txt');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    expect((await new AxeBuilder({ page }).include('#attachments').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: info.outputPath('attachments-' + theme + '.png') });
  }
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#attachments')).toBeHidden();
  await expect(page.locator('[aria-label="Sent files"]')).toHaveText('notes.txt');
  const path = await attachmentPath(page, 'notes.txt');
  const bytes = await rpc<Record<string, number>>(page, 'export', { path });
  expect(new TextDecoder().decode(new Uint8Array(Object.values(bytes)))).toBe(
    'Remember the tickets.',
  );
  await page.reload();
  await expect(page.locator('[aria-label="Sent files"]')).toHaveText('notes.txt');
});
