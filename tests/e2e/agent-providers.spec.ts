import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
// A different origin than the app, so the browser makes real CORS requests.
const providers = 'http://localhost:4174/providers/';
test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const replies = (page: Page) => page.locator('[data-role=assistant]');
async function addKey(page: Page, isMobile: boolean, name: string, provider: string, key: string) {
  if (isMobile) await page.getByRole('button', { name: 'Toggle chats' }).click();
  await page.locator('#settings-open').click();
  await page.getByRole('button', { name: /^Models/ }).click();
  const form = page.getByRole('form', { name });
  await form.getByLabel(`${name} API key`).fill(key);
  await form.locator('summary').click();
  await form.getByLabel('Endpoint').fill(providers + provider);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toContainText('Key saved');
}
async function pick(page: Page, model: string) {
  await page.locator('.model-trigger').click();
  await page.getByRole('button', { name: model, exact: true }).click();
  await expect(page.locator('.model-trigger')).toHaveAttribute(
    'aria-label',
    'Choose model, ' + model,
  );
}

test('Claude and Gemini with your own API key', async ({ page, request }, info) => {
  await request.get(base + 'reset');
  await request.get('http://127.0.0.1:4174/providers/reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });
  const mobile = Boolean(info.project.use.isMobile);

  await addKey(page, mobile, 'Claude', 'anthropic', 'sk-ant-test-key-123');
  await shot('1-models-settings');
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.locator('.model-trigger').click();
  await expect(page.locator('.model-menu')).toContainText('Claude Sonnet 5.5');
  await expect(page.getByRole('button', { name: 'ChatGPT', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await shot('2-picker');
  await page.getByRole('button', { name: 'Claude Sonnet 5.5', exact: true }).click();
  await expect(page.locator('.preview-note')).toHaveText('');

  await send(page, 'Hello Claude');
  await expect(page.locator('.thinking-note')).toContainText('The user greets me.');
  await shot('3-claude-thinking');
  await expect(replies(page).last()).toContainText('Hello from Claude.');
  await send(page, 'Claude, list my files');
  await expect(replies(page).last()).toContainText('Claude looked at your workspace');
  await shot('4-claude-tools');

  await addKey(page, mobile, 'Gemini', 'google', 'gemini-test-key-123');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await pick(page, 'Gemini 3.8 Flash');
  await send(page, 'Gemini, list my files');
  await expect(replies(page).last()).toContainText('Gemini checked your workspace.');
  await shot('5-gemini');

  // The ChatGPT request path was never used for these turns.
  const recorded = await (await request.get('http://127.0.0.1:4174/providers/requests')).json();
  expect(recorded.map((r: { provider: string }) => r.provider)).toEqual([
    'anthropic',
    'anthropic',
    'anthropic',
    'google',
    'google',
  ]);
  const chatgpt = await (await request.get(base + 'agent-requests')).json();
  expect(chatgpt).toHaveLength(0);
  // Back to ChatGPT from the same menu.
  await pick(page, 'ChatGPT');
  await send(page, 'Hi');
  await expect(replies(page).last()).not.toContainText('Gemini');
  expect(await (await request.get(base + 'agent-requests')).json()).toHaveLength(1);
});
