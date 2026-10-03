import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
});

test('the activity log in Settings shows what recent turns did', async ({ page }, info) => {
  await send(page, '/exec printf "hi" > note.txt');
  await settled(page);
  await send(page, '/exec cat missing.txt');
  await settled(page);
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await page.locator('#settings-open').click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.locator('.settings-page:not([hidden]) summary', { hasText: 'Advanced' }).click();
  const log = dialog.getByRole('list', { name: 'Recent model requests and tool calls' });
  await expect(log.locator('li').first()).toBeVisible();
  await expect(log).toContainText('Tool · exec');
  await expect(log).toContainText('Model ·');
  await log.locator('li').first().scrollIntoViewIfNeeded();
  const result = await new AxeBuilder({ page }).include('#settings-dialog').analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: info.outputPath('activity-log.png') });
});

test('switching chats shows each chat once its messages arrive', async ({ page }, info) => {
  await send(page, '/exec printf "first"');
  await settled(page);
  await page.locator('#top-new-chat').click();
  await expect(page.locator('[data-role=user]')).toHaveCount(0);
  await send(page, '/exec printf "second"');
  await settled(page);
  await expect(page.locator('[data-role=user]').last()).toContainText('second');
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await page.locator('.conversation', { hasText: 'first' }).click();
  await expect(page.locator('[data-role=user]').first()).toContainText('first');
  await expect(page.locator('[data-role=user]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('switched.png') });
});
