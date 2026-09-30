import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.route('**/account/status', (route) => route.fulfill({ json: { connected: false } }));
});

test('explains the full redirect flow and remains accessible in both themes', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/connect');
  await expect(page.getByText('Step 1 of 3')).toBeVisible();
  await expect(page.getByText('Copy the address anyway')).toBeVisible();
  await expect(page.getByLabel('Link from the address bar')).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('Appearance').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('opens ChatGPT, validates the pasted link and shows a connected state', async ({
  page,
  context,
}) => {
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: 'Test sign-in page' }),
  );
  await page.route('**/account/login', (route) =>
    route.fulfill({ json: { url: 'https://auth.openai.com/test' } }),
  );
  let callbackCount = 0;
  await page.route('**/account/callback', async (route) => {
    callbackCount++;
    expect(route.request().postDataJSON()).toEqual({
      url: 'http://127.0.0.1:1455/auth/callback?code=test&state=test',
    });
    await page.route('**/account/status', (r) => r.fulfill({ json: { connected: true } }));
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('http://127.0.0.1:4174/connect');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await (await popup).waitForURL('https://auth.openai.com/test');
  await expect(page.getByText('Step 2 of 3')).toBeVisible();
  const input = page.getByLabel('Link from the address bar');
  await input.fill('https://chatgpt.com/');
  await page.getByRole('button', { name: 'Connect & start chatting' }).click();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(callbackCount).toBe(0);
  await input.fill('http://127.0.0.1:1455/auth/callback?code=test&state=test');
  await page.getByRole('button', { name: 'Connect & start chatting' }).click();
  await expect(page.getByRole('heading', { name: 'You’re connected.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start chatting' })).toBeFocused();
  await expect(input).toHaveValue('');
  expect(callbackCount).toBe(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('expired invitations explain recovery without exposing the form', async ({ page }) => {
  await page.route('**/account/status', (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto('http://127.0.0.1:4174/connect');
  await expect(page.getByRole('alert')).toContainText('Open your latest private invitation');
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
