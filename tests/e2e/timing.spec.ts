import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('message times and elapsed work survive steering and reopening', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = async (text: string) => {
    await input.fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  };
  await send('/exec sleep 4; echo first');
  const timer = page.locator('#activity .elapsed-time');
  await expect(timer).toBeVisible();
  await expect(timer).not.toHaveText('· 0s');
  await send('/exec sleep 1; echo final');
  await expect(page.locator('[data-role=assistant] .message-content').last()).toContainText(
    'final',
  );
  await expect(page.locator('#activity')).toBeHidden();
  const duration = page.locator('.run-summary > summary').last();
  await expect(duration).toContainText(/^Worked \d/);
  const saved = await duration.textContent();
  await expect(page.locator('[data-role=user] > time')).toHaveCount(2);
  for (const time of await page.locator('.message-time').all()) {
    await expect(time).toHaveAttribute('datetime', /T/);
    await expect(time).toHaveAttribute('aria-label', /^Sent /);
    await expect(time).toBeVisible();
  }
  await page.reload();
  await expect(page.locator('.run-summary > summary').last()).toHaveText(saved!);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    expect((await new AxeBuilder({ page }).include('#timeline').analyze()).violations).toEqual([]);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
