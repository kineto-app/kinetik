import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const reply =
  '# A weekend plan\n\nStart with **one small thing**.\n\n- Pack a bag\n- Book a train\n\n[Details](https://example.org)\n\n```text\nhello world\n```\n\n| Day | Plan |\n| --- | --- |\n| Saturday | Explore |\n\n<script>window.untrusted = true</script>\n\n[Unsafe](javascript:alert(1))';
async function send(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('formats replies without active HTML and copies the original text', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, "/exec printf '%s' '" + reply + "'");
  const message = page.locator('[data-role=assistant]');
  await expect(message.getByRole('heading', { name: 'A weekend plan' })).toBeVisible();
  await expect(message.locator('strong')).toHaveText('one small thing');
  await expect(message.locator('li')).toHaveCount(2);
  await expect(message.getByRole('table')).toBeVisible();
  await expect(message.locator('script, a[href^="javascript:"]')).toHaveCount(0);
  await expect(message.getByRole('link', { name: 'Details' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await message.getByRole('button', { name: 'Copy reply', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(reply);
  await message.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
    'hello world\n',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('long replies keep the composer reachable and offer a jump back to latest', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(
    page,
    "/exec printf '%s' '" +
      Array.from(
        { length: 60 },
        (_, i) => `Paragraph ${i + 1}. Something useful to read.\n\n`,
      ).join('') +
      "'",
  );
  await expect(page.locator('[data-role=assistant]')).toContainText('Paragraph 60');
  const timeline = page.locator('#timeline');
  await timeline.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Latest message' })).toBeVisible();
  await expect(page.locator('#send')).toBeInViewport();
  await page.getByRole('button', { name: 'Latest message' }).click();
  await expect(page.getByRole('button', { name: 'Latest message' })).toBeHidden();
  expect(
    await page
      .locator('[data-role=assistant]')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
