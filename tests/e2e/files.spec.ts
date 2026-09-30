import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { attachmentPath } from './rpc';

async function send(page: Page, text: string) {
  const replies = page.locator('[data-role=assistant]');
  const count = await replies.count();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(replies).toHaveCount(count + 1);
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
}

test('inline Markdown is inert, can be copied and expanded, and preserves the shared version', async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  const content =
    '# Weekend plan\n\n- Bring a jacket\n- Book tickets\n\n<script>window.fileEscaped=true</script>\n\n![tracking](https://example.com/pixel.png)';
  await send(page, '/write /workspace/Plan.md\n' + content);
  await expect(page.locator('.file-card')).toHaveCount(0);
  await send(page, '/show_file /workspace/Plan.md');
  const card = page.locator('.file-card');
  await expect(card.getByRole('heading', { name: 'Weekend plan' })).toBeVisible();
  await expect(card.locator('li')).toHaveCount(2);
  await expect(card.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => 'fileEscaped' in window)).toBe(false);
  await card.getByRole('button', { name: 'Copy file', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(content);
  await expect(page.locator('#ui-announcement')).toHaveText('File copied to clipboard.');
  const saved = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download Plan.md', exact: true }).click();
  expect((await saved).suggestedFilename()).toBe('Plan.md');
  await send(page, '/write /workspace/Plan.md\nChanged working copy');
  await page.reload();
  await expect(card.getByRole('heading', { name: 'Weekend plan' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await expect(card.locator('.shared-file-head')).toBeVisible();
    expect((await new AxeBuilder({ page }).include('.file-card').analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`inline-files-${theme}.png`) });
  }
  await card.getByRole('button', { name: 'Expand Plan.md', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan.md' });
  await expect(dialog.getByRole('heading', { name: 'Weekend plan' })).toBeVisible();
  await expect(dialog).not.toContainText('Changed working copy');
  expect((await new AxeBuilder({ page }).include('#file-dialog').analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(card.getByRole('button', { name: 'Expand Plan.md', exact: true })).toBeFocused();
});

test('images preview inline; unsupported files remain compact and downloadable', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.locator('#upload').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V0AAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('#attachments')).toContainText('pixel.png');
  await send(page, 'Use the attached image.');
  await send(page, '/show_file ' + (await attachmentPath(page, 'pixel.png')));
  const image = page.getByRole('img', { name: 'pixel.png', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);
  await page.locator('#upload').setInputFiles({
    name: 'report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-test-fixture'),
  });
  await expect(page.locator('#attachments')).toContainText('report.pdf');
  await send(page, 'Use the attached document.');
  await send(page, '/show_file ' + (await attachmentPath(page, 'report.pdf')));
  const row = page.getByRole('button', { name: 'Open report.pdf', exact: true });
  await expect(row).toContainText('PDF · 17 B');
  await row.click();
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Download report.pdf', exact: true })
    .click();
  expect((await downloading).suggestedFilename()).toBe('report.pdf');
  await page.getByRole('button', { name: 'Close file', exact: true }).click();
  await page.locator('#top-new-chat').click();
  await expect(page.locator('.file-card')).toHaveCount(0);
});
