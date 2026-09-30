import { test, expect, type Page } from '@playwright/test';
import type { Conversation } from '../../src/core/types';
async function rpc<T>(page: Page, op: string, data: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    async ({ op, data }) => {
      const r = await navigator.serviceWorker.ready;
      return new Promise((resolve, reject) => {
        const c = new MessageChannel();
        const timeout = setTimeout(() => reject(new Error('RPC timed out')), 15000);
        c.port1.onmessage = (e) => {
          clearTimeout(timeout);
          c.port1.close();
          e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error));
        };
        r.active!.postMessage({ op, ...data }, [c.port2]);
      });
    },
    { op, data },
  ) as Promise<T>;
}
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
test.beforeEach(async ({ page, request }) => {
  await request.post('http://127.0.0.1:4174/control', { data: { revision: 1, fail: false } });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
});

test('chat shell, native skill, binary import/export and offline reload', async ({
  page,
  context,
}, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath('welcome.png') });
  await send(page, '/exec printf "hello\\n" > note.txt; cat note.txt');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre')).toContainText('hello');
  await send(page, '/read_skill skills/local/workspace/SKILL.md');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toContainText('Local workspace');
  await rpc(page, 'import', { name: 'bytes.bin', bytes: new Uint8Array([0, 255, 128]) });
  expect(
    Array.from(await rpc<Uint8Array>(page, 'export', { path: '/workspace/bytes.bin' })),
  ).toEqual([0, 255, 128]);
  await page.screenshot({ path: testInfo.outputPath('chat.png') });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, '/read /workspace/note.txt');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toHaveText(/hello/);
  await expect(page.locator('body')).not.toHaveJSProperty('scrollWidth', 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('install from URL, replace tools, refresh skills, cache on failure, explicitly update code', async ({
  page,
  request,
}) => {
  await rpc(page, 'install', { source: 'http://127.0.0.1:4174/plugin.json', settings: '{}' });
  await rpc(page, 'enable', { id: 'fixture', enabled: true });
  await send(page, '/exec hello');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toHaveText('code-1: hello');
  await request.post('http://127.0.0.1:4174/control', { data: { revision: 2 } });
  await send(page, '/skills');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toContainText('Description 2');
  await send(page, '/exec still cached');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toHaveText(
    'code-1: still cached',
  );
  await request.post('http://127.0.0.1:4174/control', { data: { fail: true } });
  await send(page, '/read_skill skills/fixture/fixture/SKILL.md');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toHaveText('# Revision 2');
  await expect(page.locator('[data-role="notice"]').last()).toContainText('using cached skills');
  await request.post('http://127.0.0.1:4174/control', { data: { fail: false } });
  await rpc(page, 'update', { id: 'fixture' });
  await send(page, '/exec updated');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toHaveText('code-2: updated');
  await rpc(page, 'enable', { id: 'fixture', enabled: false });
  await send(page, '/exec echo local');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toHaveText('local\n');
});

test('parallel turns, steering and cancellation', async ({ page }) => {
  const a = await rpc<Conversation>(page, 'create'),
    b = await rpc<Conversation>(page, 'create');
  await rpc(page, 'submit', { id: a.id, text: '/exec sleep 1; echo first' });
  await rpc(page, 'submit', { id: b.id, text: '/write /workspace/parallel\nsecond' });
  await expect
    .poll(
      async () =>
        (await rpc<{ conversations: Conversation[] }>(page, 'state')).conversations.find(
          (c) => c.id === b.id,
        )?.status,
    )
    .toBe('idle');
  await rpc(page, 'submit', { id: a.id, text: '/write /workspace/steering\nsteered' });
  await settled(page);
  expect(
    new TextDecoder().decode(
      await rpc<Uint8Array>(page, 'export', { path: '/workspace/steering' }),
    ),
  ).toBe('steered');
  await rpc(page, 'submit', { id: a.id, text: '/exec sleep 10; echo late > cancelled' });
  await expect
    .poll(
      async () =>
        (await rpc<{ conversations: Conversation[] }>(page, 'state')).conversations.find(
          (c) => c.id === a.id,
        )?.call?.state,
    )
    .toBe('pending');
  await rpc(page, 'stop', { id: a.id });
  await expect
    .poll(
      async () =>
        (await rpc<{ conversations: Conversation[] }>(page, 'state')).conversations.find(
          (c) => c.id === a.id,
        )?.status,
    )
    .toBe('needs_review');
  await rpc(page, 'resolve', { id: a.id, retry: false });
  await settled(page);
  await expect(rpc(page, 'export', { path: '/workspace/cancelled' })).rejects.toThrow();
});

test('worker termination pauses uncertain work and never silently repeats it', async ({
  page,
  context,
}) => {
  const c = await rpc<Conversation>(page, 'create');
  await rpc(page, 'submit', { id: c.id, text: '/exec echo once >> events; sleep 10' });
  await expect
    .poll(async () => {
      try {
        return new TextDecoder().decode(
          await rpc<Uint8Array>(page, 'export', { path: '/workspace/events' }),
        );
      } catch {
        return '';
      }
    })
    .toBe('once\n');
  const devtools = await context.newCDPSession(page);
  await devtools.send('ServiceWorker.enable');
  await devtools.send('ServiceWorker.stopAllWorkers');
  await devtools.detach();
  await page.reload();
  await expect
    .poll(
      async () =>
        (await rpc<{ conversations: Conversation[] }>(page, 'state')).conversations.find(
          (item) => item.id === c.id,
        )?.status,
    )
    .toBe('needs_review');
  expect(
    new TextDecoder().decode(await rpc<Uint8Array>(page, 'export', { path: '/workspace/events' })),
  ).toBe('once\n');
});

test('MCP Apps handshake, tool interaction, visibility and origin isolation', async ({
  page,
  context,
}) => {
  await rpc(page, 'install', {
    source: 'http://127.0.0.1:4173/plugins/mcp/plugin.json',
    settings: JSON.stringify({ url: 'http://127.0.0.1:4174/mcp' }),
  });
  await rpc(page, 'enable', { id: 'mcp', enabled: true });
  await send(page, '/tool mcp__show {}');
  await settled(page);
  const app = page.frameLocator('iframe.mcp-app').frameLocator('iframe');
  await expect(app.locator('#result')).toHaveText('Ready');
  await expect(app.locator('#isolation')).toHaveText('Isolated');
  await app.getByRole('button', { name: 'Forbidden tool' }).click();
  await expect(app.locator('#result')).toHaveText('Denied');
  await app.getByRole('button', { name: 'Increment' }).click();
  const action = page.locator('.tool-details').filter({ hasText: 'App · increment' });
  await action.locator('summary').click();
  await expect(action).toContainText('App · increment');
  await expect(app.locator('#result')).toHaveText('Incremented');
  expect(await page.evaluate(() => localStorage.getItem('escaped'))).toBeNull();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.frameLocator('iframe.mcp-app').frameLocator('iframe').locator('#result'),
  ).toHaveText('Ready');
});

test('routines can be created in the UI and survive reload without a second run', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'mobile-chromium') await page.locator('#menu').click();
  await page.locator('#automations-open').click();
  await page.getByLabel('What would you like done?').fill('/exec echo task >> /workspace/task.txt');
  await page.getByRole('button', { name: 'Create routine' }).click();
  await expect(page.locator('#automation-feedback')).toContainText('Saved');
  await expect
    .poll(async () => {
      await rpc(page, 'tick');
      const state = await rpc<{ automations: { status: string }[] }>(page, 'state');
      return state.automations[0]?.status;
    })
    .toBe('completed');
  await page.screenshot({ path: testInfo.outputPath('background-work.png') });
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Ready');
  await rpc(page, 'tick');
  const bytes = await rpc<Uint8Array>(page, 'export', { path: '/workspace/task.txt' });
  expect(new TextDecoder().decode(bytes)).toBe('task\n');
});

test('idle state reads do not create a worker notification loop', async ({ page }) => {
  const changes = await page.evaluate(async () => {
    let count = 0;
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'changed') count++;
    };
    navigator.serviceWorker.addEventListener('message', listener);
    await new Promise((resolve) => setTimeout(resolve, 500));
    navigator.serviceWorker.removeEventListener('message', listener);
    return count;
  });
  expect(changes).toBeLessThan(5);
});

test('background process releases the turn and later wakes it with output without another message', async ({
  page,
  context,
}, testInfo) => {
  await send(
    page,
    '/bg sleep 2; echo background-finished > /workspace/bg-result; cat /workspace/bg-result',
  );
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toContainText(
    'Started a background task.',
  );
  await expect(page.locator('#background-activity')).toContainText('1 background task running');
  await expect(page.locator('#activity')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('background-running.png') });
  // The originating model turn is done. A second foreground command can run meanwhile.
  await send(page, '/exec echo foreground-finished');
  await settled(page);
  await expect(page.locator('[data-role="assistant"] pre').last()).toContainText(
    'foreground-finished',
  );
  await expect(page.locator('[data-role="assistant"] pre').last()).toContainText(
    'Background task completed.',
  );
  await expect(page.locator('#background-activity')).toBeHidden();
  await expect(page.locator('#timeline')).not.toContainText('Background job ');
  await expect(page.locator('#timeline [data-role=tool]')).not.toContainText(
    'Completion will wake',
  );
  await page.screenshot({ path: testInfo.outputPath('background-process.png') });
  const before = await rpc<{ conversations: Conversation[] }>(page, 'state');
  const events = () =>
    before.conversations[0].messages.filter((m) => m.id.startsWith('background-completed:'));
  expect(events()).toHaveLength(1);
  expect(events()[0].visibility).toBe('internal');
  expect(events()[0].text).toContain('background-finished');
  expect(before.conversations[0].messages.filter((m) => m.role === 'user')).toHaveLength(2);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Ready');
  await settled(page);
  const after = await rpc<{ conversations: Conversation[] }>(page, 'state');
  expect(
    after.conversations[0].messages.filter((m) => m.id.startsWith('background-completed:')),
  ).toHaveLength(1);
});
