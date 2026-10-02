import { test, expect, type Page } from '@playwright/test';
import { rpc } from './rpc';
import type { Conversation } from '../../src/core/types';

test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const state = await rpc<{ conversations: Conversation[] }>(page, 'state');
      return state.conversations.every((c) => c.status === 'idle');
    })
    .toBe(true);
}
async function openWidget(page: Page) {
  await rpc(page, 'install', {
    source: 'http://127.0.0.1:4173/plugins/mcp/plugin.json',
    settings: JSON.stringify({ url: 'http://127.0.0.1:4174/mcp' }),
  });
  await rpc(page, 'enable', { id: 'mcp', enabled: true });
  await send(page, '/tool mcp__show {}');
  await settled(page);
  const app = page.frameLocator('iframe.mcp-app').frameLocator('iframe');
  await expect(app.locator('#result')).toHaveText('Ready');
  return app;
}

test.beforeEach(async ({ page, request }) => {
  await request.post('http://127.0.0.1:4174/control', { data: { revision: 1, fail: false } });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
});

test('bug 1: a widget asks before running an action that needs approval', async ({
  page,
}, info) => {
  const app = await openWidget(page);
  const card = page.getByRole('group', { name: 'App action approval' });
  await app.getByRole('button', { name: 'Publish' }).click();
  await expect(card).toContainText('Allow this app to run “publish”?');
  await expect(card).toContainText('Lisbon');
  await expect(card.getByRole('button', { name: 'Approve' })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('1-widget-approval.png') });
  await card.getByRole('button', { name: 'Decline' }).click();
  await expect(app.locator('#result')).toHaveText('Declined');
  await expect(card).toHaveCount(0);
  await app.getByRole('button', { name: 'Publish' }).click();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(app.locator('#result')).toHaveText('Published');
});

test('bug 2: a widget message goes into the composer instead of being sent', async ({
  page,
}, info) => {
  const app = await openWidget(page);
  const sent = await page.locator('[data-role=user]').count();
  await app.getByRole('button', { name: 'Suggest message' }).click();
  await expect(app.locator('#result')).toHaveText('Suggested');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Make it calmer',
  );
  await expect(page.locator('[data-role=user]')).toHaveCount(sent);
  await page.screenshot({ path: info.outputPath('2-widget-message.png') });
});

test('bug 6: a chat can be deleted with everything stored for it', async ({ page }, info) => {
  await send(page, '/exec printf "hi" > note.txt');
  await settled(page);
  const before = await rpc<{ conversations: Conversation[] }>(page, 'state');
  const id = before.conversations[0].id;
  await page.getByRole('button', { name: 'Delete chat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this chat?' });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath('3-delete-confirm.png') });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#title')).toHaveText('New chat');
  const after = await rpc<{ conversations: Conversation[] }>(page, 'state');
  expect(after.conversations.some((c) => c.id === id)).toBe(false);
  await page.screenshot({ path: info.outputPath('4-deleted.png') });
});

test('bug 4: a queued message stopped before it ran is marked as not sent', async ({
  page,
  request,
}, info) => {
  const base = 'http://127.0.0.1:4174/onboarding/';
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, 'Slow task');
  await expect(page.locator('#status')).toHaveText('Working…');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Then send me a summary');
  await page.getByRole('button', { name: 'Send after current work' }).click();
  await expect(page.locator('[data-role=user][data-queued]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop' }).click();
  const unsent = page.locator('[data-role=user][data-unsent]');
  await expect(unsent).toHaveCount(1);
  await expect(page.locator('[data-role=user][data-queued]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('5-not-sent.png') });
});
