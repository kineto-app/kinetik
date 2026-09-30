import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('packaged static launcher exits and app reopens at a subpath with no server', async ({
  page,
  context,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'kinetik-package-'));
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      encoding: 'utf8',
    }),
  )[0];
  execFileSync('tar', ['-xzf', join(directory, packed.filename), '-C', directory]);
  const child = spawn(process.execPath, [join(directory, 'package/bin/kinetik.mjs')], {
    env: {
      ...process.env,
      KINETIK_BIND: '127.0.0.1',
      KINETIK_PORT: '4180',
      KINETIK_BASE_PATH: '/kinetik-oss/',
      KINETIK_KEEP_ALIVE: '0',
      KINETIK_OPEN_BROWSER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = once(child, 'exit');
  try {
    await expect.poll(() => output).toContain('http://127.0.0.1:4180/kinetik-oss/');
    await page.goto('http://127.0.0.1:4180/kinetik-oss/');
    await expect(page.locator('#status')).toHaveText('Ready');
    await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
    await exited;
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto('http://127.0.0.1:4180/kinetik-oss/');
    await expect(reopened.locator('#status')).toHaveText('Ready');
    await reopened
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('/exec echo offline launcher');
    await reopened.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(reopened.locator('[data-role="assistant"] pre').last()).toHaveText(
      'offline launcher\n',
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
