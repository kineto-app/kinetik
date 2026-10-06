import { test, expect } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
const privacy = 'https://service.example/privacy';
test.beforeEach(async ({ request }) => {
  await request.get(base + 'reset');
});

test('consent lines name where data goes and link the privacy policy', async ({
  page,
  request,
}) => {
  await request.get(base + 'app-details');
  await page.goto(base + '?connect=charms');
  const chatgpt = page.locator('#setup-chatgpt-consent');
  await expect(chatgpt).toHaveText('Your messages and files go to OpenAI to get replies. Privacy');
  await expect(chatgpt.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', privacy);
  await expect(page.getByRole('button', { name: 'Agree and continue' })).toBeVisible();
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Connect Charms' })).toBeVisible();
  const charms = page.locator('#setup-charms-consent');
  await expect(charms).toHaveText(
    "Skills run on Example Service's servers with the files you share. Privacy",
  );
  await expect(charms.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', privacy);
});

test('without app details, lines fall back and no privacy link shows', async ({ page }) => {
  await page.goto(base + '?connect=charms');
  await expect(page.locator('#setup-chatgpt-consent span')).toHaveText(
    'Your messages and files go to OpenAI to get replies.',
  );
  await expect(page.locator('#setup-chatgpt-consent a')).toBeHidden();
  await expect(page.locator('#setup-charms-consent span')).toHaveText(
    "Skills run on the service's servers with the files you share.",
  );
});

test('settings links, the custom model consent, and reporting a reply', async ({
  page,
  request,
}, info) => {
  await request.get(base + 'app-details');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  if (info.project.use.isMobile) await page.getByRole('button', { name: 'Toggle chats' }).click();
  await page.locator('#settings-open').click();
  const settings = page.locator('#settings-dialog');
  await expect(settings.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
    'href',
    privacy,
  );
  await expect(settings.getByRole('link', { name: 'Manage account' })).toHaveAttribute(
    'href',
    'https://service.example/account',
  );
  await page.locator('.settings-account').click();
  await settings.locator('.settings-page:not([hidden])').getByText('Advanced').click();
  await expect(page.getByRole('form', { name: 'Custom model' })).toContainText(
    'Your messages go to the server you enter. Privacy',
  );
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = page.locator('[data-role=assistant]').last();
  await expect(reply).toBeVisible();
  await reply.getByRole('button', { name: 'Report reply' }).click();
  const toast = page.locator('.toast', { hasText: 'Report this reply?' });
  await expect(toast).toBeVisible();
  // The email itself is checked in unit tests; the app stays where it was.
  const url = page.url();
  await toast.getByRole('button', { name: 'Open email' }).click();
  await expect(toast).toBeHidden();
  expect(page.url()).toBe(url);
});

test('without a support address there is no report action', async ({ page, request }) => {
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role=assistant]').last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report reply' })).toHaveCount(0);
});

test('on the web, routines say they run while Kinetik is open', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.locator('#automation-hint')).toHaveText(
    'Runs while Kinetik is open. Paused routines catch up once when you return.',
  );
});
