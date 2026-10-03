import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
// A different origin than the app, so the browser makes real CORS requests.
const endpoint = 'http://localhost:4174/compat/v1';
test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const replies = (page: Page) => page.locator('[data-role=assistant]');
async function open(page: Page, request: import('@playwright/test').APIRequestContext) {
  await request.get(base + 'reset');
  await request.get('http://127.0.0.1:4174/compat/reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
}
async function setUp(page: Page, mobile: boolean, key: string) {
  if (mobile) await page.getByRole('button', { name: 'Toggle chats' }).click();
  await page.locator('#settings-open').click();
  await page.locator('.settings-account').click();
  await page
    .locator('#settings-dialog .settings-page:not([hidden])')
    .getByText('Advanced', { exact: true })
    .click();
  const form = page.getByRole('form', { name: 'Custom model' });
  await form.getByLabel('Endpoint', { exact: true }).fill(endpoint);
  await form.getByLabel('Model', { exact: true }).fill('fixture-model');
  await form.getByLabel('API key', { exact: true }).fill(key);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('button', { name: 'Remove' })).toBeVisible();
  return form;
}
async function pick(page: Page, model: string) {
  await page.locator('.model-trigger').click();
  await page.getByRole('button', { name: model, exact: true }).click();
  await expect(page.locator('.model-trigger')).toHaveAttribute(
    'aria-label',
    'Choose model, ' + model,
  );
}

test('a hidden OpenAI-compatible model next to ChatGPT', async ({ page, request }, info) => {
  await open(page, request);
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });
  const mobile = Boolean(info.project.use.isMobile);
  // Nothing about it shows until it is set up.
  await expect(page.locator('.model-trigger')).toHaveCount(0);

  await setUp(page, mobile, 'placeholder-compat-key');
  await shot('1-advanced-settings');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.locator('.model-trigger').click();
  await expect(page.locator('.model-menu')).toContainText('Custom');
  await shot('2-picker');
  await page.getByRole('button', { name: 'fixture-model', exact: true }).click();

  await send(page, 'Hello custom');
  await expect(page.locator('.thinking-note')).toContainText('The user greets me');
  await shot('3-thinking');
  await expect(replies(page).last()).toContainText('Hello from the custom model.');
  await send(page, 'Custom, list my files');
  await expect(replies(page).last()).toContainText('The custom model looked at your workspace.');
  await shot('4-tool');

  const recorded = await (await request.get('http://127.0.0.1:4174/compat/requests')).json();
  expect(recorded).toHaveLength(3);
  expect(await (await request.get(base + 'agent-requests')).json()).toHaveLength(0);
  // Back to ChatGPT from the same menu.
  await pick(page, 'ChatGPT');
  await send(page, 'Hi');
  await expect(replies(page)).toHaveCount(3);
  expect(await (await request.get(base + 'agent-requests')).json()).toHaveLength(1);
});

test('a wrong key opens the custom model settings, and a fixed key continues the turn', async ({
  page,
  request,
}, info) => {
  await open(page, request);
  const mobile = Boolean(info.project.use.isMobile);
  await setUp(page, mobile, 'placeholder-wrong-key');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await pick(page, 'fixture-model');
  await send(page, 'Hello custom');
  await expect(page.locator('#connection-wait-label')).toHaveText('Check your API key to continue');
  await page.screenshot({ path: info.outputPath('5-wrong-key.png') });
  await page.getByRole('button', { name: 'Check API key' }).click();
  const form = page.getByRole('form', { name: 'Custom model' });
  await expect(form).toBeVisible();
  await form.getByLabel('API key', { exact: true }).fill('placeholder-compat-key');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(replies(page).last()).toContainText('Hello from the custom model.');
});
