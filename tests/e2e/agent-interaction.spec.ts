import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { rpc } from './rpc';

const base = 'http://127.0.0.1:4174/onboarding/';
test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const replies = (page: Page) => page.locator('[data-role=assistant]');
async function photo(page: Page, hue: number) {
  return Buffer.from(
    await page.evaluate(async (hue) => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const context = canvas.getContext('2d')!;
      context.fillStyle = `hsl(${hue} 60% 55%)`;
      context.fillRect(0, 0, 800, 600);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png'),
      );
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, hue),
  );
}
async function open(page: Page, request: import('@playwright/test').APIRequestContext) {
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
}

test('photos, choices, approvals and memory', async ({ page, request }, info) => {
  await open(page, request);
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });

  // 2.1 The model receives the photos themselves.
  await page.locator('#upload').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: await photo(page, 20) },
    { name: 'two.png', mimeType: 'image/png', buffer: await photo(page, 200) },
  ]);
  await send(page, 'Use these photos');
  await expect(replies(page).last()).toContainText('I can see 2 photos');
  const sent = (await (await request.get(base + 'agent-requests')).json()).at(-1).input.at(-1);
  expect(sent.content.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(
    2,
  );
  expect(sent.content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
  await shot('1-photos');

  // 2.6 A question with buttons.
  await send(page, 'Pick a style');
  const ask = page.locator('#ask');
  await expect(ask).toContainText('Which style should the carousel use?');
  await expect(page.locator('#status')).toHaveText('Waiting for your answer');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    expect((await new AxeBuilder({ page }).include('#ask').analyze()).violations).toEqual([]);
  }
  await shot('2-choice');
  await ask.getByRole('button', { name: 'Calm' }).click();
  await expect(ask).toBeHidden();
  await expect(replies(page).last()).toContainText('Calm it is');

  // 2.5 Approval before an action a server marks as destructive.
  await rpc(page, 'install', {
    source: base + 'plugins/mcp/plugin.json',
    settings: JSON.stringify({ url: 'http://127.0.0.1:4174/mcp' }),
  });
  await rpc(page, 'enable', { id: 'mcp', enabled: true });
  await send(page, 'Publish my post');
  await expect(ask).toContainText('Allow Kinetik to run “publish”?');
  await expect(ask).toContainText('Three days in Lisbon');
  await shot('3-approval');
  await ask.getByRole('button', { name: 'Decline' }).click();
  await expect(replies(page).last()).toContainText('did not publish');
  await send(page, 'Publish my post');
  await ask.getByRole('button', { name: 'Approve' }).click();
  await expect(replies(page).last()).toContainText('Published your post');

  // 2.4 Memory: the agent proposes, the user confirms, Settings shows it.
  await send(page, 'Remember I write in Russian');
  await expect(ask).toContainText('Save this to your memory?');
  await expect(ask).toContainText('Writes in Russian. Prefers short answers.');
  await shot('4-memory-proposal');
  await ask.getByRole('button', { name: 'Save to memory' }).click();
  await expect(replies(page).last()).toContainText('keep that in mind');
  await send(page, 'Hi');
  const last = (await (await request.get(base + 'agent-requests')).json()).at(-1);
  expect(last.instructions).toContain('Writes in Russian. Prefers short answers.');
  if (info.project.use.isMobile) await page.getByRole('button', { name: 'Toggle chats' }).click();
  await page.locator('#settings-open').click();
  await page.getByRole('button', { name: /^Memory/ }).click();
  await expect(page.locator('#memory-text')).toHaveValue(
    'Writes in Russian. Prefers short answers.',
  );
  await shot('5-memory-settings');
});
