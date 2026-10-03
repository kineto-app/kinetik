import { protocolVersion } from '../../src/core/protocol';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = 'http://127.0.0.1:4174/onboarding/';
async function rpc(page: import('@playwright/test').Page, op: string, data = {}) {
  return page.evaluate(
    async ({ op, data, protocol }) => {
      const registration = await navigator.serviceWorker.ready;
      return new Promise<any>((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          channel.port1.close();
          data.ok ? resolve(data.result) : reject(new Error(data.error));
        };
        registration.active!.postMessage({ op, ...data, protocol }, [channel.port2]);
      });
    },
    { op, data, protocol: protocolVersion },
  );
}
test.beforeEach(async ({ request }) => {
  await request.get(base + 'reset');
});

test('guided setup authorizes Charms, loads native skills, connects ChatGPT and preserves disabled choices', async ({
  page,
  context,
}) => {
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: '<h1>ChatGPT sign-in fixture</h1>', contentType: 'text/html' }),
  );
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
  expect((await rpc(page, 'state')).plugins[0].enabledAt).toBeNull();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  const signInPage = await popup;
  await expect(signInPage.getByRole('heading', { name: 'ChatGPT sign-in fixture' })).toBeVisible();
  await signInPage.close();
  await page.getByLabel('Return link from your browser').fill('https://chatgpt.com/');
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await expect(page.locator('#setup-error')).toContainText('entire address');
  await page
    .getByLabel('Return link from your browser')
    .fill('http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture');
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Charms' })).toBeVisible();
  const charmsPopup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
  const consent = await charmsPopup;
  const consentClosed = consent.waitForEvent('close');
  await consent.getByRole('link', { name: 'Allow Charms' }).click();
  await consentClosed;
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  expect(page.url()).not.toContain('code=');
  const skills = await page.evaluate(
    async () =>
      new Promise<string>((resolve) => {
        const request = indexedDB.open('kinetik-oss-v1');
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('records').objectStore('records').getAll();
          get.onsuccess = () => {
            resolve(JSON.stringify(get.result));
            db.close();
          };
        };
      }),
  );
  expect(skills).toContain('A native fixture skill');
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-role=assistant]')).toContainText(
    'Your Charms workspace is ready.',
  );
  await rpc(page, 'enable', { id: 'charms', enabled: false });
  await page.goto(base + '?connect=charms');
  await expect(page.getByRole('button', { name: 'Enable Charms', exact: true })).toBeVisible();
  expect((await rpc(page, 'state')).plugins[0].enabledAt).toBeNull();
});

test('setup is accessible in both themes, can be skipped, and ignores untrusted deep links', async ({
  page,
}) => {
  await page.goto(base + '?connect=charms');
  await expect(page.locator('#connection-setup')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Set up later' }).click();
  await expect(page.locator('#connection-setup')).not.toBeVisible();
  await page.goto(base + '?connect=https://attacker.example/plugin.json');
  await expect(page.locator('#setup-error')).toContainText('No plugin was installed');
  expect((await rpc(page, 'state')).plugins).toHaveLength(1);
});

test('a forged OAuth callback cannot enable Charms', async ({ page }) => {
  await page.goto(base + '?connect=charms');
  await expect(page.locator('#connection-setup')).toBeVisible();
  await page.goto(base + '?connection_callback=charms&code=forged&state=forged');
  await expect(page.locator('#setup-error')).toContainText('expired');
  expect((await rpc(page, 'state')).plugins[0].enabledAt).toBeNull();
});
