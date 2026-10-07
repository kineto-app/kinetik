import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = 'http://127.0.0.1:4174/onboarding/';
const fixture = 'http://127.0.0.1:4174/';

/** Signed in to Charms from the first setup screen, then ChatGPT through the sign-in helper. */
async function connectBoth(page: Page) {
  await page.goto(base + '?connect=charms');
  await signIn(page);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await page.request.post(base + 'connections/chatgpt/callback', { data: {} });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: /^Choose model/ })).toBeVisible();
}
/** Setup while the server does not offer the model: ChatGPT through the sign-in helper, then Charms. */
async function connectBothAsBefore(
  page: Page,
  context: BrowserContext,
  beforeCharms?: () => Promise<unknown>,
) {
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: '<h1>ChatGPT sign-in fixture</h1>', contentType: 'text/html' }),
  );
  await page.goto(base + '?connect=charms');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  // Closed only once sign-in has opened in it, as a person would.
  const signInPage = await popup;
  await expect(signInPage.getByRole('heading', { name: 'ChatGPT sign-in fixture' })).toBeVisible();
  await signInPage.close();
  await page
    .getByLabel('Return link from your browser')
    .fill('http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture');
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await beforeCharms?.();
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
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await connectBoth(page);
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
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await connectBoth(page);
  await page.request.get(base + 'connections/chatgpt/logout');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // The menu offers Kinetik, and ChatGPT as a sign-in.
  await expect(page.getByRole('button', { name: 'Choose model, Kinetik' })).toBeVisible();
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

/** Kineto sign-in from the first setup screen, as the fixture authorizes it. */
async function signIn(page: Page) {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const consent = await popup;
  const closed = consent.waitForEvent('close');
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await closed;
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function connectChatGPT(page: Page, context: BrowserContext) {
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: '<h1>ChatGPT sign-in fixture</h1>', contentType: 'text/html' }),
  );
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  await (await popup).close();
  await page
    .getByLabel('Return link from your browser')
    .fill('http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture');
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
}

test('with Kinetik offered, setup starts with sign-in and ChatGPT is an optional alternative', async ({
  page,
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Sign in to start' })).toBeVisible();
  await expect(page.locator('#setup-charms-consent')).toContainText(
    "Your messages and files go to the service's servers and its AI provider to get replies.",
  );
  await expect(page.getByRole('button', { name: 'Use your ChatGPT subscription' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  }
  await expect(page.getByRole('list', { name: 'Connection progress' })).toHaveText(
    /1\s*Charms\s*2\s*Ready/,
    {
      useInnerText: true,
    },
  );
  await signIn(page);
  await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible();
  await expect(page.locator('#setup-chatgpt-ready')).toBeHidden();
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await send(page, 'Hello');
  await expect(page.locator('[data-role=assistant]')).toContainText('Hello from Kinetik.');
});

test('with Kinetik offered, connecting only ChatGPT still sets up chatting', async ({
  page,
  context,
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await page.goto(base + '?connect=charms');
  await page.getByRole('button', { name: 'Use your ChatGPT subscription' }).click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to sign-in' })).toBeVisible();
  await connectChatGPT(page, context);
  await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible();
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await send(page, 'Hello');
  await expect(page.locator('[data-role=assistant]')).toContainText(
    'Your Charms workspace is ready.',
  );
  // Charms can still be added later.
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Sign in to start' })).toBeVisible();
});

test('with Kinetik offered and nothing signed in, sending asks to sign in, not for ChatGPT', async ({
  page,
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await page.goto(base);
  await expect(page.getByRole('button', { name: 'Sign in to start' })).toBeVisible();
  await send(page, 'Hello');
  await expect(page.getByRole('heading', { name: 'Sign in to start' })).toBeVisible();
});

test('switched off on the server, setup asks for ChatGPT first as before', async ({ page }) => {
  await page.request.get(fixture + 'served/mode?value=off');
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use your ChatGPT subscription' })).toBeHidden();
  await expect(page.locator('#setup-charms-consent')).not.toContainText('AI provider');
});

test('out of credits, the web offers Top up and continuing with ChatGPT, which connects it first', async ({
  page,
  context,
}) => {
  await page.request.get(base + 'app-details');
  await page.request.get(fixture + 'served/mode?value=on');
  await page.goto(base + '?connect=charms');
  await signIn(page);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await page.request.get(fixture + 'served/mode?value=credits');
  await send(page, 'Hello');
  await expect(page.locator('.notice-title').last()).toHaveText(
    'You’re out of credits for Kinetik.',
  );
  expect(
    (await new AxeBuilder({ page }).include('#timeline').withTags(['wcag2a', 'wcag2aa']).analyze())
      .violations,
  ).toEqual([]);
  await context.route('https://service.example/**', (route) =>
    route.fulfill({ body: '<h1>Credits</h1>', contentType: 'text/html' }),
  );
  const tab = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Top up' }).click();
  await (await tab).waitForURL('https://service.example/credits');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await connectChatGPT(page, context);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await send(page, 'Hello again');
  await expect(page.locator('[data-role=assistant]').last()).toContainText(
    'Your Charms workspace is ready.',
  );
});

test('out of credits with ChatGPT connected, one tap switches to it and asks again', async ({
  page,
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await connectBoth(page);
  await page.getByRole('button', { name: /^Choose model/ }).click();
  await page
    .getByRole('dialog', { name: 'Model and reasoning' })
    .getByRole('button', { name: 'Kinetik' })
    .click();
  await page.request.get(fixture + 'served/mode?value=credits');
  await send(page, 'Hello');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.locator('[data-role=assistant]').last()).toContainText(
    'Your Charms workspace is ready.',
  );
  await page.getByRole('button', { name: /^Choose model/ }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Model and reasoning' })
      .getByRole('button', { name: 'ChatGPT' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('someone who never saw where Kinetik messages go is told once, before the first one', async ({
  page,
  context,
}) => {
  // Charms was set up while the server did not offer the model, so its step said nothing about it.
  await connectBothAsBefore(page, context, () =>
    page.request.get(fixture + 'served/mode?value=on'),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const menu = page.getByRole('dialog', { name: 'Model and reasoning' });
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: /^Choose model/ }).click();
    await expect(menu.getByRole('button', { name: 'Kinetik' })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await menu.getByRole('button', { name: 'Kinetik' }).click();
  await send(page, 'Hello');
  await expect(page.getByRole('heading', { name: 'Before you chat with Kinetik' })).toBeVisible();
  await expect(page.locator('#setup-served-consent')).toContainText(
    "Your messages and files go to the service's servers and its AI provider to get replies.",
  );
  // Declining sends nothing.
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('#connection-setup')).not.toBeVisible();
  expect((await chats(page)).filter((r) => r.path === 'chat/completions')).toHaveLength(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  await expect(page.locator('[data-role=assistant]').last()).toContainText('Hello from Kinetik.');
  await send(page, 'Again');
  await expect(page.locator('[data-role=assistant]')).toHaveCount(2);
  await expect(page.locator('#connection-setup')).not.toBeVisible();
  await page.reload();
  await send(page, 'After a restart');
  await expect(page.locator('[data-role=assistant]')).toHaveCount(3);
  await expect(page.locator('#connection-setup')).not.toBeVisible();
});

test('ChatGPT chosen and then signed out asks for it again, and the menu can still switch to Kinetik', async ({
  page,
  context,
}) => {
  await page.request.get(fixture + 'served/mode?value=on');
  await connectBoth(page, context);
  const menu = page.getByRole('dialog', { name: 'Model and reasoning' });
  const choose = async (name: string) => {
    await page.getByRole('button', { name: /^Choose model/ }).click();
    await menu.getByRole('button', { name }).click();
  };
  await choose('Kinetik');
  await choose('ChatGPT');
  await page.request.get(base + 'connections/chatgpt/logout');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: /^Choose model/ }).click();
  await expect(menu.getByRole('button', { name: 'Sign in to ChatGPT' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await send(page, 'Hello');
  await expect(page.locator('#connection-wait-label')).toHaveText('Sign in to continue');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.keyboard.press('Escape');
  await choose('Kinetik');
  // The waiting chat keeps ChatGPT; a new one uses Kinetik.
  await page.locator('#top-new-chat').click();
  await send(page, 'Hello from a new chat');
  await expect(page.locator('[data-role=assistant]').last()).toContainText('Hello from Kinetik.');
});
