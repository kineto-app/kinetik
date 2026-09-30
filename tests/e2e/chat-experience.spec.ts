import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const reply =
  '# A weekend plan\n\nStart with **one small thing**.\n\n- Pack a bag\n- Book a train\n\n[Details](https://example.org)\n\n```text\nhello world\n```\n\n| Day | Plan |\n| --- | --- |\n| Saturday | Explore |\n\n<script>window.untrusted = true</script>\n\n[Unsafe](javascript:alert(1))';
async function send(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('formats replies without active HTML and copies the original text', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, "/exec printf '%s' '" + reply + "'");
  const message = page.locator('[data-role=assistant]');
  await expect(message.getByRole('heading', { name: 'A weekend plan' })).toBeVisible();
  await expect(message.locator('strong')).toHaveText('one small thing');
  await expect(message.locator('li')).toHaveCount(2);
  await expect(message.getByRole('table')).toBeVisible();
  await expect(message.locator('script, a[href^="javascript:"]')).toHaveCount(0);
  await expect(message.getByRole('link', { name: 'Details' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await message.getByRole('button', { name: 'Copy reply', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(reply);
  await message.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
    'hello world\n',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('long replies keep the composer reachable and offer a jump back to latest', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(
    page,
    "/exec printf '%s' '" +
      Array.from(
        { length: 60 },
        (_, i) => `Paragraph ${i + 1}. Something useful to read.\n\n`,
      ).join('') +
      "'",
  );
  await expect(page.locator('[data-role=assistant]')).toContainText('Paragraph 60');
  const timeline = page.locator('#timeline');
  await timeline.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Latest message' })).toBeVisible();
  await expect(page.locator('#send')).toBeInViewport();
  await page.getByRole('button', { name: 'Latest message' }).click();
  await expect(page.getByRole('button', { name: 'Latest message' })).toBeHidden();
  expect(
    await page
      .locator('[data-role=assistant]')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('compact composer switches between stop and steering, with stop in work options', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  expect((await page.locator('#composer').boundingBox())!.height).toBeLessThan(80);
  await send(page, '/bg sleep 8; echo done');
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#send')).toBeHidden();
  await page.locator('#prompt').fill('Use a warmer tone');
  await expect(page.locator('#send')).toBeVisible();
  await expect(page.locator('#stop')).toBeHidden();
  await page.getByLabel('Work options').click();
  await expect(page.getByRole('button', { name: 'Stop work', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop work', exact: true }).click();
  await expect(page.locator('#background-activity')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('Use a warmer tone');
});

test('keyboard visual viewport keeps header and composer in the visible area', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, '/exec echo A short useful reply');
  await expect(page.locator('[data-role=assistant]')).toContainText('A short useful reply');
  await page.locator('#prompt').focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 390 });
    Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 50 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(
      async () =>
        (await page.locator('#composer').boundingBox())!.y +
        (await page.locator('#composer').boundingBox())!.height,
    )
    .toBeLessThanOrEqual(440);
  expect((await page.locator('.topbar').boundingBox())!.y).toBeGreaterThanOrEqual(50);
  await page.screenshot({ path: info.outputPath('keyboard-viewport.png') });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 844 });
    Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(async () => (await page.locator('#composer').boundingBox())!.y)
    .toBeGreaterThan(600);
});

test('tool activity is collapsed while result files remain visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, '/write /workspace/note.txt\nA useful note');
  await expect(page.locator('.file-card')).toBeVisible();
  const group = page.locator('.tool-group');
  await expect(group).toHaveCount(1);
  await expect(group).not.toHaveAttribute('open');
  await expect(group.locator('.tool-group-label')).toContainText('Created a file');
  await group.locator(':scope > summary').click();
  await expect(group.locator('.tool-details')).toBeVisible();
  await group.locator('.tool-details > summary').click();
  await expect(group.locator('.tool-details pre')).toBeVisible();
});

test('returning online resumes a persisted reply without rerunning its tool', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, '/exec echo original');
  await expect(page.locator('[data-role=assistant]')).toHaveText(/original/);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kinetik-oss-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const records = tx.objectStore('records');
      const request = records.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith('conversation:')) {
          const c = cursor.value;
          c.status = 'waiting';
          c.waitingFor = 'connection';
          c.activeMessage = c.messages.find((m: { role: string }) => m.role === 'user').id;
          c.call = {
            id: 'completed',
            name: 'exec',
            provider: 'local',
            input: {},
            state: 'completed',
            result: 'Recovered saved result',
          };
          cursor.update(c);
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('[data-role=assistant]').last()).toContainText(
    'Recovered saved result',
  );
  await expect(page.locator('#connection-wait')).toBeHidden();
  await expect(page.locator('[data-role=assistant]')).toHaveCount(2);
  expect(
    await page.locator('.composer').evaluate((el) => getComputedStyle(el).backdropFilter),
  ).not.toBe('none');
});
