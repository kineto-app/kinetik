import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const base = 'http://127.0.0.1:4174/onboarding/';

test.beforeEach(async ({ request }) => {
  await request.get(base + 'reset');
  await request.get(base + 'require-install');
});

test('hosted setup requires opening the installed app even after an accepted install prompt', async ({
  page,
}) => {
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Install Kinetik' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up later' })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#connection-setup')).toBeVisible();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    dispatchEvent(event);
  });
  await page.getByRole('button', { name: 'Install Kinetik', exact: true }).click();
  await expect(page.locator('#setup-install-instructions')).toContainText(
    'Open Kinetik from your apps.',
  );
  await expect(page.locator('#setup-chatgpt')).toBeHidden();
  await page.evaluate(() => localStorage.setItem('installed', 'true'));
  await page.reload();
  await expect(page.locator('#setup-install')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('iPhone shows manual installation steps without pretending to open an install prompt', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
    }),
  );
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Install Kinetik' })).toBeVisible();
  await expect(page.locator('#setup-install-instructions')).toContainText('Add to Home Screen');
  await expect(page.getByRole('button', { name: 'Install Kinetik', exact: true })).toBeHidden();
});

test('installed launch resumes setup without the deep link and completes the external Charms callback in the app', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: '<h1>ChatGPT sign-in fixture</h1>', contentType: 'text/html' }),
  );
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  const chatgpt = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  const signIn = await chatgpt;
  await expect(signIn.getByRole('heading', { name: 'ChatGPT sign-in fixture' })).toBeVisible();
  await signIn.close();
  await page.reload();
  await page.getByRole('button', { name: 'Paste return link' }).click();
  await page
    .getByLabel('Return link from your browser')
    .fill('http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture');
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Charms' })).toBeVisible();
  const charms = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
  const consent = await charms;
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await expect(consent.getByRole('heading', { name: 'Return to Kinetik' })).toBeVisible();
  const callback = await consent.getByLabel('Return link for Kinetik').inputValue();
  await consent.close();
  await page.reload();
  await page.locator('#setup-charms-return-option summary').click();
  await page.getByLabel('Return link from Kineto').fill(callback);
  await page.getByRole('button', { name: 'Finish connecting Charms' }).click();
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await page.reload();
  await expect(page.locator('#connection-setup')).toBeHidden();
  await expect(page.locator('#connection-status')).toContainText('Charms connected');
});

test('repository-run configuration skips installation', async ({ page, request }) => {
  await request.get(base + 'reset');
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await expect(page.locator('[data-step=install]')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Set up later' })).toBeVisible();
});

test('an optionally installed local app also receives the Charms return-link handoff', async ({
  page,
  request,
}) => {
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.goto(base + '?connect=charms');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
  const consent = await popup;
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await expect(consent.getByRole('heading', { name: 'Return to Kinetik' })).toBeVisible();
  const callback = await consent.getByLabel('Return link for Kinetik').inputValue();
  expect(new URL(callback).searchParams.get('state')).toMatch(/^app\./);
  await consent.close();
  await page.getByLabel('Return link from Kineto').fill(callback);
  await page.getByRole('button', { name: 'Finish connecting Charms' }).click();
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
});

test('Safari on Mac explains Add to Dock', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',
    }),
  );
  await page.goto(base);
  await expect(page.locator('#setup-install-instructions')).toContainText('Add to Dock');
  await expect(page.getByRole('button', { name: 'Install Kinetik', exact: true })).toBeHidden();
});

test('retries Charms activation without offering an already-consumed return link', async ({
  page,
  context,
  request,
}) => {
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  let failActivation = true;
  let tokenExchanges = 0;
  context.on('request', (request) => {
    if (request.url() === base + 'connections/charms/token') tokenExchanges++;
  });
  await context.route(base + 'connections/charms/mcp', async (route) => {
    if (route.request().postDataJSON()?.method === 'tools/list' && failActivation) {
      failActivation = false;
      await route.fulfill({ status: 503, json: { error: 'Temporary activation failure' } });
    } else await route.continue();
  });
  await page.goto(base);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
  const consent = await popup;
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await expect(consent.getByRole('heading', { name: 'Return to Kinetik' })).toBeVisible();
  const callback = await consent.getByLabel('Return link for Kinetik').inputValue();
  await consent.close();
  await page.getByLabel('Return link from Kineto').fill(callback);
  await page.getByRole('button', { name: 'Finish connecting Charms' }).click();
  await expect(page.getByRole('button', { name: 'Enable Charms', exact: true })).toBeVisible();
  await expect(page.locator('#setup-charms-return-option')).toBeHidden();
  await expect(page.locator('#setup-charms-link')).toHaveValue('');
  await page.screenshot({ path: test.info().outputPath('activation-retry.png'), fullPage: true });
  await page.getByRole('button', { name: 'Enable Charms', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  expect(tokenExchanges).toBe(1);
});

test('a return window with standalone display mode does not consume the code before its first paste', async ({
  page,
  context,
  request,
}) => {
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await context.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { value: true }),
  );
  let exchanges = 0;
  context.on('request', (request) => {
    if (request.url() === base + 'connections/charms/token') exchanges++;
  });
  await page.goto(base);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
  const consent = await popup;
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await expect(consent.getByRole('heading', { name: 'Return to Kinetik' })).toBeVisible();
  expect(exchanges).toBe(0);
  const callback = await consent.getByLabel('Return link for Kinetik').inputValue();
  await consent.close();
  await page.getByLabel('Return link from Kineto').fill(callback);
  await page.getByRole('button', { name: 'Finish connecting Charms' }).click();
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  expect(exchanges).toBe(1);
});
