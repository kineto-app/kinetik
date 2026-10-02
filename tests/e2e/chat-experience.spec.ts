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
}, info) => {
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
  const jump = page.getByRole('button', { name: 'Latest message' });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText('');
  expect(await jump.boundingBox()).toMatchObject({ width: 44, height: 44 });
  await page.screenshot({ path: info.outputPath('jump-button.png') });
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
  await expect(page.locator('.file-card')).toHaveCount(0);
  const group = page.locator('.tool-group');
  await expect(group).toHaveCount(1);
  await expect(group).not.toHaveAttribute('open');
  await expect(group.locator('.tool-group-label')).toContainText('Saved a file');
  await group.locator(':scope > summary').click();
  await expect(group.locator('.tool-details')).toBeVisible();
  await group.locator('.tool-details > summary').click();
  await expect(group.locator('.activity-explanation')).toHaveText('Saved “note.txt”.');
  await expect(group.locator('.tool-details pre')).toHaveCount(0);
  await group.getByText('Technical details', { exact: true }).click();
  await expect(group.locator('.tool-details pre')).toBeVisible();
  await send(page, '/show_file /workspace/note.txt');
  await expect(page.locator('.file-card')).toBeVisible();
  await send(page, '/write /workspace/note.txt\nNew working version');
  await page.reload();
  await page
    .locator('.file-card')
    .getByRole('button', { name: /^Expand / })
    .click();
  await expect(page.locator('#file-preview-text')).toHaveText('A useful note');
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

test('a transient connection failure reconnects automatically while the app stays visible', async ({
  page,
  request,
}) => {
  const base = 'http://127.0.0.1:4174/onboarding/';
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'fail-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, 'Hello');
  await expect(page.locator('#connection-wait')).toBeVisible();
  await expect(page.locator('[data-role=assistant]')).toContainText(
    'Your Charms workspace is ready.',
    { timeout: 8000 },
  );
  await expect(page.locator('#connection-wait')).toBeHidden();
  expect((await (await request.get(base + 'stats')).json()).modelRequests).toBe(2);
});

test('narration persists and separates consecutive tools into distinct activity groups', async ({
  page,
  request,
}) => {
  const base = 'http://127.0.0.1:4174/onboarding/';
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'narrated-model');
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, 'Create slides');
  await expect(page.locator('[data-role=assistant]').last()).toContainText('The slides are ready.');
  await expect(page.locator('[data-role=assistant]')).toHaveCount(3);
  await expect(page.locator('.tool-group')).toHaveCount(2);
  await expect(page.locator('.tool-group').nth(0).locator('.tool-details')).toHaveCount(2);
  await expect(page.locator('.tool-group').nth(1).locator('.tool-details')).toHaveCount(1);
  expect(
    await page
      .locator('#timeline > .tool-group, #timeline > [data-role=assistant]')
      .evaluateAll((nodes) =>
        nodes.map((n) =>
          n.classList.contains('tool-group')
            ? 'tools'
            : n.querySelector('.message-content')?.textContent?.trim(),
        ),
      ),
  ).toEqual([
    'I will create the slides.',
    'tools',
    'The draft is ready. I will check it.',
    'tools',
    'The slides are ready.',
  ]);
  await page.reload();
  await expect(page.locator('[data-role=assistant]')).toHaveCount(3);
  await expect(page.locator('.tool-group')).toHaveCount(2);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.locator('.tool-group > summary').first().click();
  await page.screenshot({ path: test.info().outputPath('narration-persisted.png') });
});

test('a streaming reply shows Markdown formatting before it completes', async ({
  page,
  request,
}, info) => {
  const base = 'http://127.0.0.1:4174/onboarding/';
  await request.get(base + 'reset');
  await request.post(base + 'connections/chatgpt/callback', { data: {} });
  await request.get(base + 'stream-model');
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto(base);
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, 'Plan my weekend');
  const draft = page.locator('[data-draft]');
  await expect(draft.locator('strong')).toHaveText('the plan');
  await expect(draft.locator('li')).toHaveCount(2);
  await expect(draft.locator('.code-block code')).toHaveText('const ready =');
  await expect(draft).toContainText('Writing');
  await expect(draft.locator('.work-duration')).toHaveText('Working…');
  await expect(draft).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-role=assistant]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('streaming-markdown.png') });
  const streamedTop = (await draft.locator('strong').boundingBox())!.y;
  await request.get(base + 'finish-stream');
  const message = page.locator('[data-role=assistant]');
  await expect(message.locator('.code-block code')).toHaveText('const ready = true;');
  // The draft reserves the "Worked for" line, so the final reply lands without moving.
  await expect(message.locator('.work-duration')).toContainText('Worked for');
  expect(Math.abs((await message.locator('strong').boundingBox())!.y - streamedTop)).toBeLessThan(
    1,
  );
  await expect(draft).toHaveCount(0);
  await expect(message.locator('strong')).toHaveText('the plan');
  await expect(message).not.toHaveClass(/message-enter/);
  expect(errors).toEqual([]);
});

test('sidebar lists chats with a colour dot and age, and keeps New chat at the bottom', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, 'Plan my weekend');
  await expect(page.locator('[data-role=assistant]')).toHaveCount(1);
  if (info.project.use.isMobile) await page.getByRole('button', { name: 'Toggle chats' }).click();
  const chats = page.getByRole('navigation', { name: 'Recent chats' });
  const chat = chats.getByRole('button', { name: /Plan my weekend/ });
  await expect(chat).toHaveAttribute('aria-current', 'true');
  await expect(chat.locator('.conversation-dot')).toBeVisible();
  await expect(chat.locator('time')).toHaveText('now');
  const sidebar = page.locator('#sidebar');
  const newChat = sidebar.getByRole('button', { name: 'New chat' });
  await expect(newChat.locator('svg')).toBeVisible();
  // The last control in the sidebar, closest to the thumb.
  expect(
    await sidebar.evaluate((el) => [...el.querySelectorAll('button:not([hidden])')].at(-1)?.id),
  ).toBe('new-chat');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    // The phone drawer's own role="dialog" on <aside> is a known, separate issue.
    expect(
      (await new AxeBuilder({ page }).include('#conversations').include('#new-chat').analyze())
        .violations,
    ).toEqual([]);
  }
  await page.screenshot({ path: info.outputPath('sidebar.png') });
  await newChat.click();
  await expect(page.locator('#title')).toHaveText('New chat');
});
