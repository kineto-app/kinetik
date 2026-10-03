import { test, expect, type Page } from '@playwright/test';

const base = 'http://127.0.0.1:4174/onboarding/';
// The headless shell refuses notifications even when granted; full Chromium shows them.
test.use({ video: 'on', channel: 'chromium' });

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const replies = (page: Page) => page.locator('[data-role=assistant]');
async function open(page: Page, request: import('@playwright/test').APIRequestContext) {
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'agent-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
}

test('queue after the current work, and a notification when it finishes', async ({
  page,
  request,
  context,
}, info) => {
  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:4174' });
  await open(page, request);
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });

  // 2.3 Turn the switch on in Settings.
  if (info.project.use.isMobile) await page.getByRole('button', { name: 'Toggle chats' }).click();
  await page.locator('#settings-open').click();
  const toggle = page.getByRole('switch', { name: 'Notify me when work finishes' });
  await toggle.check();
  await expect(toggle).toBeChecked();
  await shot('6-notify-setting');
  await page.getByRole('button', { name: 'Close settings' }).click();

  // 2.2 While a slow task runs, queue a message for afterwards.
  await send(page, 'Slow task');
  await expect(page.locator('#status')).toHaveText('Working…');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Then send me a summary');
  await page.getByRole('button', { name: 'Send after current work' }).click();
  const queued = page.locator('[data-role=user][data-queued]');
  await expect(queued).toHaveCount(1);
  await shot('7-queued');
  await expect(replies(page).first()).toContainText('Slow task finished.');
  await expect(replies(page).last()).toContainText('summary you queued');
  await expect(queued).toHaveCount(0);
  const order = await replies(page).allTextContents();
  expect(order.findIndex((t) => t.includes('Slow task finished'))).toBeLessThan(
    order.findIndex((t) => t.includes('summary you queued')),
  );

  // The finished-work notification appears when no Kinetik window is in front.
  await send(page, 'Slow task');
  await expect(page.locator('#status')).toHaveText('Working…');
  // No Kinetik window may be in front while the work finishes, so leave the app entirely.
  await page.goto('about:blank');
  await page.waitForTimeout(6000);
  const checker = await context.newPage();
  await checker.goto(base + 'manifest.webmanifest');
  await expect
    .poll(
      async () =>
        checker.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration('/onboarding/');
          return (await registration?.getNotifications())?.map((n) => n.body) ?? [];
        }),
      { timeout: 15000 },
    )
    .toContain('Slow task finished.');
  // A visible record of the system notification the service worker showed.
  await checker.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/onboarding/');
    const [shown] = (await registration!.getNotifications()) ?? [];
    document.body.innerHTML = `<div style="font:16px system-ui;margin:24px;padding:16px;border-radius:14px;background:#2b2a33;color:#fff;max-width:360px"><b>${shown.title}</b><br>${shown.body}</div>`;
  });
  await checker.screenshot({ path: info.outputPath('8-notification.png') });
});

test('work that ends in another chat shows a notice and a dot until it is opened', async ({
  page,
  request,
}, info) => {
  await open(page, request);
  await send(page, 'Slow task');
  await expect(page.locator('#status')).toHaveText('Working…');
  await page.locator('#top-new-chat').click();
  const notice = page.locator('.toast').filter({ hasText: '“Slow task” is ready' });
  await expect(notice).toBeVisible({ timeout: 15000 });
  if (info.project.use.isMobile) await page.getByRole('button', { name: 'Toggle chats' }).click();
  const row = page.locator('.conversation').filter({ hasText: 'Slow task' });
  await expect(row.locator('.conversation-title.unread')).toBeVisible();
  await page.screenshot({ path: info.outputPath('9-other-chat-ready.png') });
  if (info.project.use.isMobile) await page.locator('#menu-close').click();
  await notice.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('#title')).toHaveText('Slow task');
  await expect(replies(page).last()).toContainText('Slow task finished.');
  await expect(row.locator('.conversation-title.unread')).toHaveCount(0);
});

test('a notification opens its chat, and a long task offers notifications once', async ({
  page,
  request,
}, info) => {
  await page.clock.install();
  await open(page, request);
  await send(page, 'Slow task');
  await expect(page.locator('#status')).toHaveText('Working…');
  // The page's clock stands still unless moved; a minute makes the task look long.
  await page.clock.fastForward('01:00');
  const offer = page.locator('.toast').filter({ hasText: 'Want a notification' });
  await expect(offer).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: info.outputPath('10-offer.png') });
  await offer.getByRole('button', { name: 'Dismiss' }).click();
  const id = await page.evaluate(() => sessionStorage.getItem('kinetik-conversation'));
  await page.locator('#top-new-chat').click();
  await expect(page.locator('#title')).toHaveText('New chat');
  // A tapped notification opens the app on its chat.
  await page.goto(base + '?chat=' + id);
  await expect(page.locator('#title')).toHaveText('Slow task');
  expect(new URL(page.url()).search).toBe('');
  await send(page, 'Slow task');
  await expect(replies(page)).toHaveCount(2);
  await expect(page.locator('.toast').filter({ hasText: 'Want a notification' })).toHaveCount(0);
});
