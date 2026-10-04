import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('a run shows every step with its time, and its total after the last reply', async ({
  page,
  request,
}, info) => {
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, 'Build the slides');
  await expect(page.locator('[data-role=assistant]').last()).toContainText('change the style.', {
    timeout: 30000,
  });

  // The message you sent always shows when you sent it.
  await expect(page.locator('[data-role=user] > .message-time')).toBeVisible();
  expect(
    await page
      .locator('[data-role=user] > .message-time')
      .evaluate((node) => getComputedStyle(node).opacity),
  ).toBe('1');

  // Steps stay where they happened, each group with its time.
  const group = page.locator('.tool-group').first();
  await expect(group.locator(':scope > summary .activity-time')).toHaveText(/^\d+(\.\d)?s$/);

  // After the last reply: how long the whole run took, and every step with its own time.
  const run = page.locator('.run-summary');
  await expect(run).toHaveCount(1);
  await expect(run.locator('> summary')).toHaveText(/^Worked \d+s · 3 steps · \d\d:\d\d/);
  await page.screenshot({ path: info.outputPath('1-run-closed.png') });
  await run.locator('> summary').click();
  await expect(run.locator('.tool-details')).toHaveCount(3);
  // "Ran sleep" took seconds; instant saves show no time at all.
  await expect(run.locator('.tool-details .activity-time')).toHaveCount(1);
  for (const time of await run.locator('.tool-details .activity-time').all())
    await expect(time).toHaveText(/^\d+(\.\d)?s$/);
  await page.screenshot({ path: info.outputPath('2-run-open.png') });

  // An older reply takes no room for its hidden copy button: no gap under it.
  await send(page, 'Hi');
  await expect(page.locator('.run-summary')).toHaveCount(2);
  const older = page.locator('[data-role=assistant]').first();
  await expect(older.locator('.message-actions')).toBeHidden();
  const gap = await older.evaluate((node) => {
    const text = node.querySelector('.message-content')!.getBoundingClientRect();
    return node.nextElementSibling!.getBoundingClientRect().top - text.bottom;
  });
  expect(gap).toBeLessThan(30);
  await older.locator('.message-content').click();
  await expect(older.locator('.message-actions')).toBeVisible();

  // A reload rebuilds the same total from what was saved.
  const total = await run.first().locator('> summary').textContent();
  await page.reload();
  await expect(page.locator('.run-summary > summary').first()).toHaveText(total!);
});

test('background work is a live step while it runs, then a step with its time', async ({
  page,
}, info) => {
  await page.goto('/');
  await send(page, '/bg sleep 3; echo done-in-background');
  // The group's own line names the work, counts its time and shows that it is alive.
  const live = page.locator('.tool-group[data-outcome=running] > summary');
  await expect(live).toContainText('in the background');
  await expect(live.locator('.activity-progress')).toBeVisible();
  const clock = live.locator('[data-started-at]');
  const first = await clock.textContent();
  await expect(clock).not.toHaveText(first!, { timeout: 4000 });
  // No total yet: the run is not over while its background work runs.
  await expect(page.locator('.run-summary')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('3-background-running.png') });
  await expect(page.locator('.run-summary > summary')).toContainText(/^Worked \d+s · \d+ steps/, {
    timeout: 15000,
  });
  await expect(page.locator('.tool-group').last()).toContainText('in the background');
  await expect(page.locator('[data-outcome=running]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('4-background-done.png') });
});
