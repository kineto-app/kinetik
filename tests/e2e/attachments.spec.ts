import { test, expect, type Page } from '@playwright/test';
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
  const sent = page.getByRole('list', { name: 'Sent files' });
  await expect(sent.getByRole('listitem')).toHaveText('TXTnotes.txtTXT · 21 B');
  await expect(sent.getByRole('button', { name: 'Download notes.txt' })).toBeVisible();
  const path = await attachmentPath(page, 'notes.txt');
  const bytes = await rpc<Record<string, number>>(page, 'export', { path });
  expect(new TextDecoder().decode(new Uint8Array(Object.values(bytes)))).toBe(
    'Remember the tickets.',
  );
  await page.reload();
  await expect(page.getByRole('list', { name: 'Sent files' })).toContainText('notes.txt');
});

async function photo(page: Page, hue: number) {
  const bytes = await page.evaluate(async (hue) => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = `hsl(${hue} 55% 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = `hsl(${hue + 40} 70% 75%)`;
    context.beginPath();
    context.arc(1500, 700, 500, 0, Math.PI * 2);
    context.fill();
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/png'),
    );
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, hue);
  return Buffer.from(bytes);
}

test('photos preview in the composer, the sent message, and a full-screen viewer', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  // One picker selection with several files keeps their order.
  await page.locator('#upload').setInputFiles([
    ...(await Promise.all(
      [20, 200, 300].map(async (hue, index) => ({
        name: `photo-${index + 1}.png`,
        mimeType: 'image/png',
        buffer: await photo(page, hue),
      })),
    )),
    ...['brief.pdf', 'remove.txt'].map((name) => ({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('%PDF-1.4'),
    })),
  ]);
  const tray = page.getByRole('list', { name: 'Attached files' });
  await expect(tray.getByRole('listitem')).toHaveCount(5);
  expect(
    await tray
      .getByRole('listitem')
      .evaluateAll((items) => items.map((i) => i.getAttribute('title'))),
  ).toEqual(['photo-1.png', 'photo-2.png', 'photo-3.png', 'brief.pdf', 'remove.txt']);
  await expect(page.locator('#ui-announcement')).toHaveText('Attached 5 files');
  await expect(tray.getByRole('img', { name: 'photo-3.png' })).toBeVisible();
  await expect(page.locator('#composer')).toHaveClass(/expanded/);
  await page.getByRole('button', { name: 'Remove remove.txt', exact: true }).click();
  await expect(tray.getByRole('listitem')).toHaveCount(4);
  await expect(page.locator('[data-role=user]')).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    expect((await new AxeBuilder({ page }).include('#composer').analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath('composer-tray-' + theme + '.png') });
  }
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use these photos');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(tray).toBeHidden();
  await expect(page.locator('#composer')).not.toHaveClass(/expanded/);
  const sent = page.getByRole('list', { name: 'Sent files' });
  await expect(sent.getByRole('listitem')).toHaveCount(4);
  await expect(sent.getByRole('listitem').last()).toContainText('brief.pdf');
  await expect(sent.getByRole('img', { name: 'photo-1.png' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    expect(
      (await new AxeBuilder({ page }).include('[data-role=user]').analyze()).violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath('sent-files-' + theme + '.png') });
  }
  const opener = sent.getByRole('button', { name: 'Open photo-2.png' });
  await opener.click();
  const viewer = page.getByRole('dialog', { name: 'Photos' });
  await expect(viewer).toContainText('2 / 3');
  await expect(viewer.getByRole('img', { name: 'photo-2.png' })).toBeInViewport();
  await page.keyboard.press('ArrowRight');
  await expect(viewer).toContainText('3 / 3');
  await expect(viewer.getByRole('img', { name: 'photo-3.png' })).toBeInViewport();
  expect((await new AxeBuilder({ page }).include('.photo-viewer').analyze()).violations).toEqual(
    [],
  );
  await page.screenshot({ path: info.outputPath('photo-viewer.png') });
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(opener).toBeFocused();
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Sent files' }).getByRole('img', { name: 'photo-1.png' }),
  ).toBeVisible();
});
