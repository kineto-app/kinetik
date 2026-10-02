import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { rpc } from './rpc';

async function accessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    })),
  ).toEqual([]);
}
async function openSettings(page: Page) {
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await page.locator('#settings-open').click();
}

test('settings pages hold appearance, data and every connection', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
  await rpc(page, 'install', {
    source: new URL('plugins/example/plugin.json', page.url()).href,
    settings: '{}',
  });
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Ready');
  const html = page.locator('html');
  const dialog = page.locator('#settings-dialog');
  const heading = page.locator('#settings-heading');
  const shown = dialog.locator('.settings-page:not([hidden])');
  const shot = async (name: string) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
  };

  await openSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^ChatGPT/ })).toContainText('Preview');
  await expect(dialog.getByRole('button', { name: /^Connections/ })).toContainText('0 on');
  await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
  const appearance = dialog.getByRole('radiogroup', { name: 'Appearance' });
  await expect(appearance.getByRole('radio', { name: 'Auto' })).toBeChecked();
  await appearance.getByRole('radio', { name: 'Dark' }).check();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await appearance.getByRole('radio', { name: 'Light' }).check();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await openSettings(page);
  await expect(appearance.getByRole('radio', { name: 'Light' })).toBeChecked();

  for (const theme of ['light', 'dark'] as const) {
    await appearance.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).check();
    await expect(html).toHaveAttribute('data-theme', theme);
    await accessible(page);
    await shot(`settings-root-${theme}`);

    await dialog.getByRole('button', { name: /^Connections/ }).click();
    await expect(page.getByRole('dialog', { name: 'Connections', exact: true })).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(dialog.getByRole('button', { name: /^ChatGPT/ })).toContainText(
      'Unavailable on this host',
    );
    const example = dialog.getByRole('button', { name: /^Example workspace/ });
    await expect(example).toContainText('Version 1.0.0 · Off');
    await accessible(page);
    await shot(`connections-${theme}`);

    await example.click();
    await expect(
      page.getByRole('dialog', { name: 'Example workspace', exact: true }),
    ).toBeVisible();
    await expect(shown.getByText('Off', { exact: true })).toBeVisible();
    await expect(shown.getByText('1.0.0', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible();
    await shown.getByText('Advanced', { exact: true }).click();
    await expect(shown.getByText(/plugins\/example\/plugin\.json$/)).toBeVisible();
    await accessible(page);
    await shot(`connection-service-${theme}`);

    await page.getByRole('button', { name: 'Back to Connections' }).click();
    await expect(page.getByRole('dialog', { name: 'Connections', exact: true })).toBeVisible();
    await expect(example).toBeFocused();
    await page.getByRole('button', { name: 'Back to Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Connections/ })).toBeFocused();

    await dialog.getByRole('button', { name: /^Connections/ }).click();
    await dialog.getByRole('button', { name: 'Add a connection', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add a connection', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Connection link')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Use demo connection' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add connection', exact: true })).toBeVisible();
    await accessible(page);
    await shot(`connection-add-${theme}`);
    await page.getByRole('button', { name: 'Back to Connections' }).click();
    await page.getByRole('button', { name: 'Back to Settings' }).click();

    await dialog.getByRole('button', { name: /^ChatGPT/ }).click();
    await expect(page.getByRole('dialog', { name: 'ChatGPT', exact: true })).toBeVisible();
    await expect(shown.getByText('Unavailable on this host', { exact: true })).toBeVisible();
    await expect(shown.getByText(/You’re trying a preview/)).toBeVisible();
    await accessible(page);
    await page.getByRole('button', { name: 'Back to Settings' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }

  await page.getByRole('button', { name: 'Close settings' }).click();
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click();
  await page.locator('#connections-open').click();
  await expect(page.getByRole('dialog', { name: 'Connections', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Example workspace/ }).click();
  await page.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Connections' }).click();
  await page.getByRole('button', { name: 'Back to Settings' }).click();
  await expect(dialog.getByRole('button', { name: /^Connections/ })).toContainText('1 on');
});
