import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const base = 'http://127.0.0.1:4174/onboarding/';

async function focusApp(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function authorize(page: Page) {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
  return popup;
}

test.beforeEach(async ({ request }) => {
  await request.get(base + 'reset');
  await request.get(base + 'require-install');
});

test('hosted setup works without installing and offers installation separately', async ({
  page,
}) => {
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up later' })).toBeVisible();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: test.info().outputPath('browser-setup-dark.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#connection-setup')).toBeHidden();
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await page.locator('#install-open').click();
  await expect(page.getByRole('heading', { name: 'Install Kinetik' })).toBeVisible();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    dispatchEvent(event);
  });
  await page.locator('#setup-install-button').click();
  await expect(page.locator('#setup-install-instructions')).toContainText(
    'Open Kinetik from your apps.',
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.screenshot({ path: test.info().outputPath('optional-install-' + theme + '.png') });
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  }
  await page.getByRole('button', { name: 'Continue in browser' }).click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
});

test('after "Later", setup does not open by itself again; the status button still opens it', async ({
  page,
}, info) => {
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up later' }).click();
  await page.reload();
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#connection-setup')).toBeHidden();
  await page.screenshot({ path: info.outputPath('after-later-reload.png') });
  await page.locator('#connection-status').click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
});

test('with a custom model set up, setup does not open by itself on the next launch', async ({
  page,
}, info) => {
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.keyboard.press('Escape');
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await page.locator('#settings-open').click();
  await page.locator('.settings-account').click();
  await page
    .locator('#settings-dialog .settings-page:not([hidden])')
    .getByText('Advanced', { exact: true })
    .click();
  const form = page.getByRole('form', { name: 'Custom model' });
  await form.getByLabel('Endpoint', { exact: true }).fill('http://localhost:4174/compat/v1');
  await form.getByLabel('Model', { exact: true }).fill('fixture-model');
  await form.getByLabel('API key', { exact: true }).fill('sk-fixture-key-123456');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('button', { name: 'Remove' })).toBeVisible();
  await page.reload();
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#connection-setup')).toBeHidden();
  await page.screenshot({ path: info.outputPath('custom-model-reload.png') });
});

test('iPhone offers manual installation without blocking account setup', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
    }),
  );
  await page.goto(base);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('#setup-install-instructions')).toContainText('Add to Home Screen');
  await expect(page.locator('#setup-install-button')).toBeHidden();
  await page.getByRole('button', { name: 'Continue in browser' }).click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
});

test('installed launch resumes setup and completes a shared-storage Charms redirect automatically', async ({
  page,
  context,
  request,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: '<h1>ChatGPT sign-in fixture</h1>', contentType: 'text/html' }),
  );
  await page.goto(base);
  await expect(page.locator('#setup-install-open')).toBeHidden();
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
  const consent = await authorize(page);
  const closed = consent.waitForEvent('close');
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await closed;
  await focusApp(page);
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await page.reload();
  await expect(page.locator('#connection-setup')).toBeHidden();
  await expect(page.locator('#connection-status')).toBeHidden();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role=assistant]')).toContainText(
    'Your Charms workspace is ready.',
  );
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: test.info().outputPath(`header-${theme}.png`) });
  }
  await page.locator('#top-new-chat').click();
  await expect(page.locator('#title')).toHaveText('New chat');
  await expect(page.locator('[data-role=assistant]')).toHaveCount(0);
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await expect(page.locator('#connections-summary')).toHaveText('ChatGPT · Charms');
  await page.screenshot({ path: test.info().outputPath('connections-sidebar.png') });
  await page.locator('#connections-open').click();
  await expect(page.getByRole('dialog', { name: 'Connections', exact: true })).toBeVisible();
  await expect(page.locator('#connection-setup')).toBeHidden();
  await expect(page.getByRole('heading', { name: /You.re ready/ })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeHidden();
  await expect(page.locator('#drawer-scrim')).toBeHidden();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath('sidebar-connections.png') });
  const settings = page.locator('#settings-dialog');
  await expect(settings.getByRole('button', { name: /^ChatGPT\b/ })).toContainText('Connected');
  await settings.getByRole('button', { name: /^Charms\b/ }).click();
  await expect(page.getByRole('dialog', { name: 'Charms', exact: true })).toBeVisible();
  await expect(
    settings.locator('.settings-page:not([hidden])').getByText('Connected', { exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath('connection-charms.png') });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await request.post(base + 'connections/chatgpt/logout');
  await focusApp(page);
  await expect(page.locator('#connection-status')).toBeVisible();
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await page.locator('#connections-open').click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up later' }).click();
  await expect(page.locator('#connection-status')).toBeVisible();
  await expect(page.locator('#connection-status')).toHaveAttribute('title', 'Connect ChatGPT');
  await page.locator('#connection-status').click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up later' }).click();
  const shown = settings.locator('.settings-page:not([hidden])');
  const openService = async (name: string) => {
    if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
    await page.locator('#settings-open').click();
    await settings.getByRole('button', { name: /^Connections/ }).click();
    await settings.getByRole('button', { name: new RegExp('^' + name) }).click();
    await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();
  };
  await openService('ChatGPT');
  await expect(shown.getByText('Not connected', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up later' }).click();
  await openService('Charms');
  await settings.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(shown.getByText('Not connected', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Connect Charms', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Disconnect', exact: true })).toBeHidden();
});

test('repository-run configuration also keeps installation optional', async ({ page, request }) => {
  await request.get(base + 'reset');
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await expect(page.locator('[data-step=install]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
});

test('separate browser storage keeps a manual Charms fallback without consuming the code', async ({
  page,
  browser,
  request,
}) => {
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.goto(base);
  const consent = await authorize(page);
  const callback = await consent.getByRole('link', { name: 'Allow Charms' }).getAttribute('href');
  await consent.close();
  const isolated = await browser.newContext();
  try {
    const external = await isolated.newPage();
    await external.goto(new URL(callback!, base).href);
    await expect(external.getByRole('heading', { name: 'Return to Kinetik' })).toBeVisible();
    const link = await external.getByLabel('Return link for Kinetik').inputValue();
    await page.reload();
    await page.locator('#setup-charms-return-option summary').click();
    await page.getByLabel('Return link from Kineto').fill(link);
    await page.getByRole('button', { name: 'Finish connecting Charms' }).click();
    await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  } finally {
    await isolated.close();
  }
});

test('Safari on Mac offers Add to Dock and browser continuation', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',
    }),
  );
  await page.goto(base);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('#setup-install-instructions')).toContainText('Add to Dock');
  await expect(page.locator('#setup-install-button')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Continue in browser' })).toBeVisible();
});

test('retries Charms activation after a redirect without reusing its consumed code', async ({
  page,
  request,
}) => {
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await request.get(base + 'fail-activation');
  await page.goto(base);
  const consent = await authorize(page);
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await expect(consent.getByRole('button', { name: 'Enable Charms', exact: true })).toBeVisible();
  await consent.close();
  await focusApp(page);
  await expect(page.getByRole('button', { name: 'Enable Charms', exact: true })).toBeVisible();
  await expect(page.locator('#setup-charms-return-option')).toBeHidden();
  await expect(page.locator('#setup-charms-link')).toHaveValue('');
  await page.getByRole('button', { name: 'Enable Charms', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  expect((await (await request.get(base + 'stats')).json()).tokenExchanges).toBe(1);
});

test('a callback that opens in standalone mode also connects automatically exactly once', async ({
  page,
  context,
  request,
}) => {
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await context.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { value: true }),
  );
  await page.goto(base);
  const consent = await authorize(page);
  const closed = consent.waitForEvent('close');
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await closed;
  await focusApp(page);
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  expect((await (await request.get(base + 'stats')).json()).tokenExchanges).toBe(1);
});
