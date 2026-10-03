import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const replies = (page: Page) => page.locator('[data-role=assistant]');

test('parallel read-only tools and a helper agent', async ({ page, request }, info) => {
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });

  // Two reads in one response run together; both outputs go back in the next request.
  await send(page, 'Compare my folders');
  await expect(replies(page).last()).toContainText('Checked both folders at once');
  const requests = await (await request.get(base + 'agent-requests')).json();
  const outputs = requests
    .at(-1)
    .input.filter((item: { type?: string }) => item.type === 'function_call_output');
  expect(outputs.map((o: { call_id: string }) => o.call_id)).toEqual(['p-1', 'p-2']);
  const group = page.locator('.tool-group').last();
  await group.locator(':scope > summary').click();
  await expect(group.locator('.tool-details')).toHaveCount(2);
  await shot('1-parallel');

  // A batch with writes runs nothing; the agent then saves one at a time.
  await send(page, 'Save two notes');
  await expect(replies(page).last()).toContainText('Saved both notes, one at a time.');
  await expect(page.locator('.tool-group').last().locator(':scope > summary')).toContainText(
    '2 handled',
  );
  await shot('2-batch-refused');

  // A helper agent reads on its own and reports back.
  await send(page, 'Ask a helper about my slides');
  await expect(page.locator('#activity-label')).toHaveText('Asking a helper');
  await expect(page.locator('#activity-label')).toHaveAttribute('title', /helper step 2/);
  await shot('3-helper-working');
  await expect(replies(page).last()).toContainText('The helper reports: There are two slides');
  const helper = (await (await request.get(base + 'agent-requests')).json()).filter(
    (r: { instructions?: string }) => r.instructions?.startsWith('You are a helper'),
  );
  expect(helper).toHaveLength(3);
  expect(helper[0].input).toEqual([
    { role: 'user', content: 'List the slides in /workspace and describe each.' },
  ]);
  await shot('4-helper-done');
});
