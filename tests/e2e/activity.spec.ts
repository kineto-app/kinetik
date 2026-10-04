import { protocolVersion } from '../../src/core/protocol';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Conversation, Message } from '../../src/core/types';

const msg = (id: string, role: Message['role'], text: string): Message => ({
  id,
  role,
  text,
  createdAt: 1,
});
const action = (
  id: string,
  tool: string,
  input: Record<string, unknown>,
  outcome: NonNullable<Message['activity']>['outcome'] = 'completed',
): Message => ({
  ...msg(
    id,
    'tool',
    JSON.stringify({ result: 'Saved result', render_token: 'placeholder-hidden-token' }),
  ),
  tool,
  activity: { input, outcome },
});
async function seed(page: Page, messages: Message[]) {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.evaluate(
    async ({ messages, protocol }) => {
      // Wait for the worker to create the store before opening it from the page.
      const registration = await navigator.serviceWorker.ready;
      await new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          channel.port1.close();
          event.data.ok ? resolve() : reject(new Error(event.data.error));
        };
        registration.active!.postMessage({ op: 'state', protocol }, [channel.port2]);
      });
      const db = await new Promise<IDBDatabase>((resolve) => {
        const open = indexedDB.open('kinetik-oss-v1', 1);
        open.onsuccess = () => resolve(open.result);
      });
      const conversation: Conversation = {
        id: 'activity-test',
        title: 'Weekend packing list',
        messages,
        pending: [],
        status: 'idle',
        updatedAt: Date.now(),
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put(conversation, 'conversation:activity-test');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      sessionStorage.setItem('kinetik-conversation', conversation.id);
    },
    { messages, protocol: protocolVersion },
  );
  await page.reload();
  await expect(page.locator('#title')).toHaveText('Weekend packing list');
}

test('activity combines repeats, explains retries, and keeps technical output optional', async ({
  page,
}, info) => {
  await seed(page, [
    msg('u', 'user', 'Make a packing list for a weekend away.'),
    msg('n', 'assistant', 'I’ll check your notes and prepare the list.'),
    action('r1', 'charms__charms_files_read · charms', { path: '/workspace/trip.md' }),
    action('r2', 'charms__charms_files_read · charms', { path: '/workspace/preferences.md' }),
    action('e1', 'exec · charms', { command: 'python3 packing.py' }, 'failed'),
    action('e2', 'exec · charms', { command: 'python3 packing.py' }),
    action('r3', 'charms__charms_files_read · charms', { path: '/workspace/trip.md' }),
    msg('n2', 'assistant', 'The list is ready. I’m saving it for you.'),
    {
      ...action('w', 'write · local', { path: '/workspace/packing.txt' }),
      file: { path: '/workspace/packing.txt', name: 'packing.txt' },
    },
    msg('final', 'assistant', 'Here’s your weekend packing list.'),
  ]);
  const cards = page.locator('.tool-group');
  await expect(cards).toHaveCount(2);
  const first = cards.first();
  await expect(first).not.toHaveAttribute('open');
  // Collapsed: plain words for what happened, and a retried failure counts as fixed.
  await expect(first.locator(':scope > summary')).toHaveText('Read 2 files, ran a command1 fixed');
  await expect(page.locator('.file-card')).toBeVisible();
  await expect(page.locator('.activity-json pre')).toHaveCount(0);
  await first.locator(':scope > summary').click();
  // Open: one flat list in order, no middle grouping level.
  const rows = first.locator('.tool-group-steps > .tool-details');
  await expect(rows).toHaveCount(5);
  await expect(first.locator('.activity-batch')).toHaveCount(0);
  await expect(rows.nth(0).locator(':scope > summary')).toHaveText('Read trip.md');
  await expect(rows.nth(2).locator(':scope > summary')).toHaveText('Run python3Fixed');
  await expect(rows.nth(3).locator(':scope > summary')).toHaveText('Ran python3');
  expect((await rows.nth(0).locator(':scope > summary').boundingBox())!.height).toBeLessThan(34);
  await expect(first).toHaveAttribute('data-outcome', 'completed');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const axe = await new AxeBuilder({ page }).include('.tool-group').analyze();
    expect(axe.violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`activity-${theme}.png`) });
  }
  const failedAttempt = rows.nth(2);
  await failedAttempt.locator(':scope > summary').click();
  await expect(failedAttempt.locator('.activity-explanation')).toContainText('later retry');
  await expect(failedAttempt.locator('pre')).toHaveCount(0);
  // Details open in place as a submenu: tool and place first, then Input and Result on demand.
  await expect(failedAttempt.locator('.activity-facts')).toHaveText('Toolexec · Charms');
  await failedAttempt.getByText('Input', { exact: true }).click();
  const input = failedAttempt.locator('.activity-json').first().locator('pre');
  await expect(input).toContainText('python3 packing.py');
  await expect(input.locator('.json-key')).toHaveText('"command"');
  await expect(input.locator('.json-string')).toHaveText('"python3 packing.py"');
  await failedAttempt.getByText('Result', { exact: true }).click();
  const result = failedAttempt.locator('.activity-json').last().locator('pre');
  await expect(result).not.toContainText('placeholder-hidden-token');
  await expect(result).toContainText('[redacted]');
  await expect(failedAttempt.getByRole('button', { name: 'Copy result' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('step-details.png') });
  await page.reload();
  await expect(cards).toHaveCount(2);
  await expect(first).toHaveAttribute('data-outcome', 'completed');
});

test('unrelated successes cannot hide errors and long untrusted data stays inert', async ({
  page,
}) => {
  await seed(page, [
    msg('u', 'user', 'Check my files.'),
    action('fail', 'exec · charms', { command: 'build' }, 'failed'),
    action('other', 'exec · charms', { command: 'pwd' }),
    {
      ...action('unsafe', 'read · local', { path: '<script>alert(1)</script>' }),
      text: '<img src=x onerror="window.escaped=true">',
    },
  ]);
  const card = page.locator('.tool-group');
  await expect(card.locator(':scope > summary')).toContainText('1 failed');
  await card.locator(':scope > summary').click();
  await expect(card.locator('.tool-details').first().locator(':scope > summary')).toContainText(
    'Failed',
  );
  const unsafe = card.locator('.tool-details').last();
  await unsafe.locator(':scope > summary').click();
  await unsafe.getByText('Result', { exact: true }).click();
  await expect(unsafe.locator('pre')).toContainText('<img');
  await expect(unsafe.locator('pre img')).toHaveCount(0);
  expect(await page.evaluate(() => 'escaped' in window)).toBe(false);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a live command keeps the activity card open when its result arrives', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('/exec sleep 2; echo finished');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.locator('.tool-group');
  await expect(card).toHaveAttribute('data-outcome', 'running');
  await card.locator(':scope > summary').click();
  // A single step opens straight into its details instead of repeating the card title.
  await expect(card.locator('.tool-details')).toHaveCount(0);
  const input = card.locator('.activity-json').first();
  await input.locator(':scope > summary').click();
  await expect(card).toHaveAttribute('data-outcome', 'completed');
  await expect(card).toHaveAttribute('open');
  await expect(input).toHaveAttribute('open');
  await expect(input.locator(':scope > summary')).toBeFocused();
  await expect(page.locator('[data-role=assistant]')).toContainText('finished');
});

test('an explicitly shared background result is visible, its step too, without its receipt text', async ({
  page,
}) => {
  await seed(page, [
    msg('u', 'user', 'Prepare a file'),
    {
      ...action('share', 'show_file · local', { path: '/workspace/result.txt' }),
      visibility: 'internal',
      text: 'internal sharing receipt',
      file: { path: '/workspace/result.txt', name: 'result.txt' },
    },
    msg('a', 'assistant', 'Your file is ready.'),
  ]);
  await expect(page.locator('.file-card')).toContainText('result.txt');
  // The sharing step is shown like any other; its raw receipt stays behind Result.
  await expect(page.locator('.tool-group')).toHaveCount(1);
  await expect(page.locator('#timeline')).not.toContainText('internal sharing receipt');
});

test('widget refreshes stay out of the agent timeline after its final reply', async ({ page }) => {
  await seed(page, [
    msg('u', 'user', 'Create a track.'),
    msg('n', 'assistant', 'I will create the track.'),
    action('generate', 'exec · charms', { command: 'generate-audio' }),
    msg('final', 'assistant', 'Your track is ready.'),
    action('poll-legacy', 'App · refresh', {}),
    {
      ...action('poll', 'App · refresh', {}),
      activity: { scope: 'app:player', input: {}, outcome: 'completed' },
    },
  ]);
  await expect(page.locator('.tool-group')).toHaveCount(1);
  await expect(
    page.locator('[data-message-id="poll"], [data-message-id="poll-legacy"]'),
  ).toHaveCount(0);
  expect(
    await page
      .locator('#timeline > .tool-group, #timeline > [data-role=assistant]')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          node.classList.contains('tool-group')
            ? 'tools'
            : node.querySelector('.message-content')?.textContent?.trim(),
        ),
      ),
  ).toEqual(['I will create the track.', 'tools', 'Your track is ready.']);
});
