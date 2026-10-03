import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const replies = (page: Page) => page.locator('[data-role=assistant]');

test('usage, self-correction, automatic summaries and overflow recovery', async ({
  page,
  request,
}, info) => {
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });

  // 1.1 Usage is shown on the reply.
  await send(page, 'Hi');
  await expect(replies(page)).toHaveCount(1);
  await expect(page.locator('.work-duration').last()).not.toContainText('tokens');
  await expect(page.locator('.work-duration').last()).toHaveAttribute('title', /Tokens: \d+ in/);
  await shot('1-usage');

  // 1.4 Bad arguments and a missing file go back to the model, which finishes the job.
  await send(page, 'Save my trip note');
  await expect(replies(page).last()).toContainText('Saved your trip note');
  const activity = page.locator('.tool-group').last();
  await expect(activity.locator(':scope > summary')).toContainText('2 handled');
  await expect(activity.locator(':scope > summary')).not.toContainText('failed');
  await activity.locator(':scope > summary').click();
  await expect(activity.locator('.tool-details').filter({ hasText: 'Handled' })).toHaveCount(2);
  await activity.locator('.tool-details').first().locator(':scope > summary').click();
  await expect(activity.locator('.activity-explanation').first()).toContainText(
    'error went back to the agent',
  );
  await expect(page.locator('#status')).not.toContainText('review');
  await shot('2-self-correction');

  // 1.2 A nearly full context is summarised automatically before the next request.
  await send(page, 'Fill the context');
  await expect(replies(page).last()).toContainText('long document');
  await send(page, 'What did we plan?');
  await expect(page.locator('#activity-label')).toHaveText('Summarising earlier messages…');
  await shot('3a-summarising');
  await expect(page.locator('.compaction-note')).toHaveCount(1);
  await expect(page.locator('.compaction-note')).toContainText('Earlier messages summarised');
  await expect(replies(page).last()).toContainText('I still remember');
  const requests = await (await request.get(base + 'agent-requests')).json();
  const latest = requests.at(-1).input;
  expect(latest[0].content).toMatch(/^Summary of the earlier conversation:\nThe user is planning/);
  expect(latest.at(-1)).toMatchObject({ role: 'user', content: 'What did we plan?' });
  await page.locator('.compaction-note').scrollIntoViewIfNeeded();
  await shot('3-auto-summary');

  // 1.3 A context overflow is summarised once and retried without the user doing anything.
  await send(page, 'Overflow now');
  await expect(page.locator('.compaction-note')).toHaveCount(2);
  await expect(replies(page).last()).toContainText('I still remember');
  await shot('4-overflow-recovered');

  // On demand: nothing new to summarise right after a summary, then it works once there is.
  await send(page, '/compact');
  await expect(page.locator('#timeline')).toContainText('Nothing to summarise yet.');
  await send(page, 'One more thing');
  await expect(replies(page).last()).toContainText('I still remember');
  await send(page, '/compact');
  await expect(page.locator('.compaction-note')).toHaveCount(3);
  await page.reload();
  await expect(page.locator('.compaction-note')).toHaveCount(3);
  await shot('5-after-reload');
});
