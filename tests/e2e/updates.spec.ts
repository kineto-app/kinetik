import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Conversation } from '../../src/core/types';
import AxeBuilder from '@axe-core/playwright';

let server: Server;
let origin: string;
let revision: number;
let broken: boolean;
let browserLogin = false;
const prefix = '/kinetik-oss/';
test.beforeEach(async () => {
  revision = 1;
  browserLogin = false;
  broken = false;
  const { build } = JSON.parse(await readFile('dist/version.json', 'utf8'));
  const files = new Map<string, Buffer>();
  for (const file of await readdir('dist', { recursive: true })) {
    try {
      files.set(file, await readFile('dist/' + file));
    } catch {
      /* Directory. */
    }
  }
  server = createServer((request, response) => {
    const path = new URL(request.url!, origin).pathname.slice(prefix.length) || 'index.html';
    if (path === 'config.json' && browserLogin) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          connections: {},
          chatgpt: { mode: 'browser', jwksUrl: './connections/chatgpt/keys' },
        }),
      );
      return;
    }
    const content = files.get(path);
    if (!content || (broken && path === 'index.html')) {
      response.writeHead(503).end();
      return;
    }
    const extension = path.split('.').at(-1)!;
    response.setHeader(
      'Content-Type',
      (
        {
          js: 'text/javascript',
          css: 'text/css',
          html: 'text/html',
          svg: 'image/svg+xml',
          json: 'application/json',
          webmanifest: 'application/manifest+json',
        } as Record<string, string>
      )[extension] ?? 'application/octet-stream',
    );
    response.setHeader('Cache-Control', 'no-store');
    response.end(
      path === 'sw.js' ? content.toString().replaceAll(build, 'release-' + revision) : content,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function rpc<T>(page: Page, op: string, data = {}): Promise<T> {
  return page.evaluate(
    async ({ op, data }) => {
      const registration = await navigator.serviceWorker.ready;
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          channel.port1.close();
          data.ok ? resolve(data.result) : reject(new Error(data.error));
        };
        registration.active!.postMessage({ op, ...data }, [channel.port2]);
      });
    },
    { op, data },
  ) as Promise<T>;
}
async function checkUpdate(page: Page) {
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.ready).update();
  });
}
async function send(page: Page, text: string) {
  await page.locator('#prompt').fill(text);
  await page.locator('#send').click();
}

test('updates require a click, keep drafts across tabs, and apply from the offline cache', async ({
  page,
  context,
}, info) => {
  await page.goto(origin + prefix);
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.locator('#app-update')).toBeHidden();
  await send(page, '/write /workspace/kept\nkeep this file');
  await expect(page.locator('[data-role=assistant]')).toContainText('Saved');
  const other = await context.newPage();
  await other.goto(origin + prefix);
  await expect(other.locator('#status')).toHaveText('Ready');
  await page.locator('#prompt').fill('unsent first tab');
  await other.locator('#prompt').fill('unsent second tab');
  revision = 2;
  await checkUpdate(page);
  await expect(page.locator('#app-update')).toBeVisible();
  await expect(other.locator('#app-update')).toBeVisible();
  expect(await rpc(page, 'version')).toBe('release-1');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`update-${theme}.png`) });
  }
  await context.setOffline(true);
  const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  await page.locator('#app-update-apply').click();
  await reloaded;
  await expect(page.locator('#status')).toHaveText('Ready');
  expect(await rpc(page, 'version')).toBe('release-2');
  await expect(page.locator('#app-update')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('unsent first tab');
  await expect(other.locator('#prompt')).toHaveValue('unsent second tab');
  await expect(other.locator('#app-update')).toBeHidden();
  await expect(page.locator('[data-role=assistant]')).toContainText('Saved');
  const bytes = await rpc<Uint8Array>(page, 'export', { path: '/workspace/kept' });
  expect(new TextDecoder().decode(bytes)).toBe('keep this file');
  await context.setOffline(false);
  revision = 3;
  await checkUpdate(page);
  await expect(page.locator('#app-update')).toBeVisible();
  expect(await rpc(page, 'version')).toBe('release-2');
  await expect(page.locator('#prompt')).toHaveValue('unsent first tab');
});

test('waiting updates do not recover live work, and cannot activate during foreground or background execution', async ({
  page,
}) => {
  await page.goto(origin + prefix);
  await expect(page.locator('#status')).toHaveText('Ready');
  await send(page, '/bg sleep 3; echo once >> /workspace/background');
  await expect(page.locator('#background-activity')).toBeVisible();
  revision = 2;
  await checkUpdate(page);
  await expect(page.locator('#app-update')).toBeVisible();
  await page.locator('#app-update-apply').click();
  await expect(page.locator('#app-update-feedback')).toContainText('Work is still running');
  expect(await rpc(page, 'version')).toBe('release-1');
  await expect(page.locator('#background-activity')).toBeHidden();
  const state = await rpc<{ conversations: Conversation[] }>(page, 'state');
  expect(state.conversations[0].messages.find((m) => m.source === 'background')?.text).toContain(
    'completed.',
  );
  await send(page, '/exec sleep 2; echo foreground');
  await expect(page.locator('#activity')).toBeVisible();
  await page.locator('#app-update-apply').click();
  await expect(page.locator('#app-update-feedback')).toContainText('Work is still running');
  await expect(page.locator('#activity')).toBeHidden();
  const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  await page.locator('#app-update-apply').click();
  await reloaded;
  await expect(page.locator('#status')).toHaveText('Ready');
  expect(await rpc(page, 'version')).toBe('release-2');
  expect(
    new TextDecoder().decode(
      await rpc<Uint8Array>(page, 'export', { path: '/workspace/background' }),
    ),
  ).toBe('once\n');
});

test('failed downloads leave the current version usable and can be retried', async ({ page }) => {
  await page.goto(origin + prefix);
  await expect(page.locator('#status')).toHaveText('Ready');
  revision = 2;
  broken = true;
  await checkUpdate(page);
  await expect
    .poll(async () =>
      page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).installing)),
    )
    .toBe(false);
  await expect(page.locator('#app-update')).toBeHidden();
  expect(await rpc(page, 'version')).toBe('release-1');
  await send(page, '/exec echo still works');
  await expect(page.locator('[data-role=assistant]')).toContainText('still works');
  broken = false;
  await checkUpdate(page);
  await expect(page.locator('#app-update')).toBeVisible();
  expect(await rpc(page, 'version')).toBe('release-1');
});

test('updates stay reachable inside setup, dialogs and the mobile chat drawer', async ({
  page,
}, info) => {
  await page.goto(origin + prefix);
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.evaluate(() =>
    document.querySelector<HTMLDialogElement>('#connection-setup')!.showModal(),
  );
  revision = 2;
  await checkUpdate(page);
  const update = page.locator('#app-update-apply');
  await expect(page.locator('#connection-setup #app-update')).toBeVisible();
  await update.click({ trial: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await expect(page.locator('#connection-setup')).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`setup-update-${theme}.png`) });
  }
  await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('#connection-setup')!;
    dialog.querySelector<HTMLElement>('.setup-body')!.style.minHeight = '200vh';
    dialog.scrollTop = dialog.scrollHeight;
  });
  expect((await update.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect((await update.boundingBox())!.y).toBeLessThan(page.viewportSize()!.height);
  await update.click({ trial: true });
  await page.evaluate(() =>
    document.querySelector<HTMLDialogElement>('#connection-setup')!.close(),
  );

  for (const id of ['settings-dialog', 'file-dialog', 'plugins-dialog', 'automations-dialog']) {
    await page.evaluate(
      (id) => document.querySelector<HTMLDialogElement>('#' + id)!.showModal(),
      id,
    );
    await expect(page.locator('#' + id + ' #app-update')).toBeVisible();
    await update.click({ trial: true });
    await page.evaluate((id) => document.querySelector<HTMLDialogElement>('#' + id)!.close(), id);
  }
  if (info.project.name === 'mobile-chromium') {
    await page.getByRole('button', { name: 'Toggle chats' }).click();
    await expect(page.locator('#sidebar #app-update')).toBeVisible();
    await update.click({ trial: true });
    await update.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#settings-open')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(update).toBeFocused();
    await page.getByRole('button', { name: 'Close chats', exact: true }).first().click();
  }
  await expect(page.locator('#main #app-update')).toBeVisible();
  await page.evaluate(() =>
    document.querySelector<HTMLDialogElement>('#connection-setup')!.showModal(),
  );
  const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  await update.click();
  await reloaded;
  await expect(page.locator('#status')).toHaveText('Ready');
  expect(await rpc(page, 'version')).toBe('release-2');
});

test('app updates preserve the saved browser login', async ({ page }) => {
  browserLogin = true;
  await page.goto(origin + prefix);
  await expect(page.locator('#status')).toHaveText('Ready');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kinetik-chatgpt-v1', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('records');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('records', 'readwrite');
          tx.objectStore('records').put(
            {
              access: 'fixture-access',
              refresh: 'fixture-refresh',
              expires: Date.now() + 3600000,
              account: 'fixture-person',
              model: 'fixture-model',
            },
            'session',
          );
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  expect(
    (await rpc<{ chatgpt: { connected: boolean } }>(page, 'setupState')).chatgpt.connected,
  ).toBe(true);
  revision = 2;
  await checkUpdate(page);
  await expect(page.locator('#app-update')).toBeVisible();
  const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  await page.locator('#app-update-apply').click();
  await reloaded;
  await expect(page.locator('#status')).toHaveText('Ready');
  expect(await rpc(page, 'version')).toBe('release-2');
  await expect(page.locator('#app-update')).toBeHidden();
  expect(
    (await rpc<{ chatgpt: { connected: boolean } }>(page, 'setupState')).chatgpt.connected,
  ).toBe(true);
});
