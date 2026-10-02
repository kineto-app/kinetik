import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
test.use({ video: 'on' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const stateCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { stateCalls: number }).stateCalls);

test('live step progress and streamed text arrive as events', async ({ page, request }, info) => {
  // Counts full state reloads the page asks the worker for.
  await page.addInitScript(() => {
    const counter = window as unknown as { stateCalls: number };
    counter.stateCalls = 0;
    const post = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (
      this: ServiceWorker,
      ...args: Parameters<ServiceWorker['postMessage']>
    ) {
      if ((args[0] as { op?: string })?.op === 'state') counter.stateCalls++;
      return post.apply(this, args as never);
    } as ServiceWorker['postMessage'];
  });
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });
  const label = page.locator('#activity-label');

  await send(page, 'Build the slides');
  await expect(label).toHaveText('Running a command · step 3');
  await shot('1-step');

  // A reload mid-turn shows the same progress from stored state alone.
  await page.reload();
  await expect(label).toHaveText('Running a command · step 3');
  await shot('2-after-reload');

  const draft = page.locator('[data-draft]');
  await expect(draft).toContainText('Your three slides');
  const before = await stateCalls(page);
  await expect(draft).toContainText('day-two plan');
  await shot('3-streaming');
  await expect(page.locator('[data-role=assistant]').last()).toContainText('change the style.');
  await expect(draft).toHaveCount(0);
  // About 25 streamed words; only the persisted final reply reloads state.
  expect((await stateCalls(page)) - before).toBeLessThanOrEqual(4);
  await expect(page.locator('#activity')).toBeHidden();
});
