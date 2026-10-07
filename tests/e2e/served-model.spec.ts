import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
const fixture = 'http://127.0.0.1:4174/';

/** Guided setup as it is today: ChatGPT through the sign-in helper, then Charms. */
async function connectBoth(page: Page, context: BrowserContext) {
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: '<h1>ChatGPT sign-in fixture</h1>', contentType: 'text/html' }),
  );
  await page.goto(base + '?connect=charms');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  await (await popup).close();
  await page
    .getByLabel('Return link from your browser')
    .fill('http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture');
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  const charmsPopup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
  const consent = await charmsPopup;
  const closed = consent.waitForEvent('close');
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await closed;
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Start chatting' }).click();
}
const chats = async (page: Page) =>
  (await (await page.request.get(fixture + 'served/requests')).json()) as {
    path: string;
    auth?: string;
    body?: { model?: string };
  }[];
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await request.get(base + 'reset');
});

test('the model menu lists Kinetik with ChatGPT, remembers the choice, and offers no reasoning for it', async ({
  page,
  context,
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await connectBoth(page, context);
  // Signed in to ChatGPT with nothing chosen, ChatGPT answers.
  await send(page, 'Hello');
  await expect(page.locator('[data-role=assistant]')).toContainText(
    'Your Charms workspace is ready.',
  );
  const menu = page.getByRole('dialog', { name: 'Model and reasoning' });
  await page.getByRole('button', { name: /^Choose model/ }).click();
  await expect(menu.getByRole('button', { name: 'ChatGPT' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await menu.getByRole('button', { name: 'Kinetik' }).click();
  await page.reload();
  await page.getByRole('button', { name: /^Choose model/ }).click();
  await expect(menu.getByRole('button', { name: 'Kinetik' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(menu.getByRole('group', { name: 'Reasoning' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A turn keeps the model it started with; the next one in the same chat uses the choice.
  await send(page, 'Hi Kinetik');
  await expect(page.locator('[data-role=assistant]').last()).toContainText('Hello from Kinetik.');
  const request = (await chats(page)).find((r) => r.path === 'chat/completions')!;
  expect(request.auth).toBe('Bearer placeholder-charms-token');
  expect(request.body?.model).toBe('kinetik');
});

test('with Charms alone, chats use Kinetik; switched off on the server, ChatGPT is needed again', async ({
  page,
  context,
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await connectBoth(page, context);
  await page.request.get(base + 'connections/chatgpt/logout');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Choose model, Kinetik' })).toHaveCount(0);
  await send(page, 'Hello');
  await expect(page.locator('[data-role=assistant]')).toContainText('Hello from Kinetik.');
  await expect(page.locator('#connection-setup')).not.toBeVisible();

  // Switched off on the server: the turn says so, and the next chat needs ChatGPT again.
  await page.request.get(fixture + 'served/mode?value=disabled');
  await send(page, 'Hello again');
  await expect(page.locator('.notice-title').last()).toHaveText(
    'Kinetik isn’t available right now. Choose another model.',
  );
  await send(page, 'One more');
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
});
