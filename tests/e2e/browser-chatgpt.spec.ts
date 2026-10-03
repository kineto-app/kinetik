import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
const base = 'http://127.0.0.1:4174/onboarding/';
for (const relay of [false, true]) {
  test(`browser login (${relay ? 'relay' : 'direct'}) survives worker termination and reopening without another sign-in`, async ({
    page,
    context,
    request,
  }) => {
    await request.get(base + 'reset');
    await request.get(base + 'browser-chatgpt' + (relay ? '?relay=1' : ''));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let flow: URL;
    let requests = 0;
    let modelListUnavailable = false;
    await context.route(base + 'connections/chatgpt/keys', (route) =>
      route.fulfill({
        json: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig' }] },
      }),
    );
    await context.route('https://auth.openai.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/authorize')) {
        flow = url;
        await route.fulfill({ contentType: 'text/html', body: '<h1>Sign in fixture</h1>' });
        return;
      }
      if (url.pathname.endsWith('/token')) {
        const form = new URLSearchParams(route.request().postData()!);
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
          flow.searchParams.get('code_challenge'),
        );
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString(
          'base64url',
        );
        const payload = Buffer.from(
          JSON.stringify({
            iss: 'https://auth.openai.com',
            aud: 'browser-client',
            sub: 'test-person',
            nonce: flow.searchParams.get('nonce'),
            exp: Date.now() / 1000 + 600,
          }),
        ).toString('base64url');
        const signature = sign(
          'RSA-SHA256',
          Buffer.from(header + '.' + payload),
          privateKey,
        ).toString('base64url');
        await route.fulfill({
          json: {
            access_token: 'placeholder-browser-access',
            refresh_token: 'placeholder-browser-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'chatgpt.tokens.use.direct',
            id_token: header + '.' + payload + '.' + signature,
          },
        });
        return;
      }
      await route.fulfill({ status: 404 });
    });
    if (relay)
      await context.route('https://api.openai.com/v1/**', (route) => route.abort('failed'));
    await context.route(
      relay ? base + 'connections/chatgpt/model/**' : 'https://api.openai.com/v1/**',
      async (route) => {
        if (relay) {
          expect(route.request().method()).toBe('POST');
          expect(route.request().headers().origin).toBe(new URL(base).origin);
          expect(route.request().headers().cookie).toBeUndefined();
        }
        expect(route.request().headers().authorization).toBe('Bearer placeholder-browser-access');
        if (route.request().url().endsWith('/models')) {
          if (modelListUnavailable) {
            await route.fulfill({ status: 503, json: { error: 'Unavailable' } });
            return;
          }
          await route.fulfill({
            json: {
              models: [
                {
                  slug: 'test-model',
                  display_name: 'Test model',
                  visibility: 'list',
                  default_reasoning_level: 'low',
                  supported_reasoning_levels: [
                    { effort: 'low', description: 'Fast responses' },
                    { effort: 'high', description: 'Deeper reasoning' },
                    { effort: 'ultra', description: 'Automatic task delegation' },
                  ],
                },
                {
                  slug: 'gpt-6.1-sol',
                  display_name: 'GPT-6.1 Sol',
                  visibility: 'list',
                  // The catalog default differs from the app's medium default on purpose.
                  default_reasoning_level: 'low',
                  supported_reasoning_levels: [
                    { effort: 'low', description: 'Fast responses with lighter reasoning' },
                    {
                      effort: 'medium',
                      description: 'Balances speed and depth for everyday tasks',
                    },
                    { effort: 'high', description: 'Greater depth for complex problems' },
                    { effort: 'xhigh', description: 'Extra depth for complex problems' },
                    { effort: 'max', description: 'Maximum depth for the hardest problems' },
                  ],
                },
                { slug: 'hidden-model', display_name: 'Hidden model', visibility: 'hidden' },
              ],
            },
          });
          return;
        }
        requests++;
        const body = route.request().postDataJSON();
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        expect(body.model).toBe(requests === 1 ? 'gpt-6.1-sol' : 'test-model');
        expect(body.reasoning).toEqual({
          effort: requests === 1 ? 'medium' : 'high',
          summary: 'auto',
        });
        await route.fulfill({
          contentType: 'text/event-stream',
          body:
            'data: ' +
            JSON.stringify({
              type: 'response.completed',
              response: {
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: 'Browser subscription transport works.' },
                    ],
                  },
                ],
              },
            }) +
            '\n\n',
        });
      },
    );
    await page.goto(base + '?connect=charms');
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
    const auth = await popup;
    await expect(auth.getByRole('heading', { name: 'Sign in fixture' })).toBeVisible();
    await auth.close();
    await page.getByLabel('Return link from your browser').fill(
      'http://127.0.0.1:1455/auth/callback?' +
        new URLSearchParams({
          code: 'fixture',
          state: flow!.searchParams.get('state')!,
          client_id: 'browser-client',
        }),
    );
    await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect Charms' })).toBeVisible();
    const charmsPopup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Connect Charms', exact: true }).click();
    const consent = await charmsPopup;
    const consentClosed = consent.waitForEvent('close');
    await consent.getByRole('link', { name: 'Allow Charms' }).click();
    await consentClosed;
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Start chatting' }).click();
    await page.reload();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('[data-role=assistant]')).toContainText(
      'Browser subscription transport works.',
    );
    expect(requests).toBe(1);
    expect(await page.locator('body').innerText()).not.toContain('browser-secret');
    const saved = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const open = indexedDB.open('kinetik-chatgpt-v1');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const read = open.result.transaction('records').objectStore('records').getAll();
            read.onsuccess = () => {
              resolve(JSON.stringify(read.result));
              open.result.close();
            };
            read.onerror = () => reject(read.error);
          };
        }),
    );
    expect(saved).toContain('placeholder-browser-access');
    expect(saved).toContain('placeholder-browser-refresh');
    const picker = page.getByRole('button', { name: 'Choose model, GPT-6.1 Sol' });
    await expect(
      page.locator('#composer').getByRole('button', { name: /^Choose model/ }),
    ).toBeVisible();
    const sentBefore = await page.locator('[data-role=user]').count();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft stays');
    await picker.click();
    await expect(page.getByRole('button', { name: 'Test model', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hidden model' })).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include('.model-menu').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: test.info().outputPath('model-picker-light.png') });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await page.screenshot({ path: test.info().outputPath('model-picker-dark.png') });
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
    await expect(page.locator('[data-role=user]')).toHaveCount(sentBefore);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Draft stays',
    );
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
    await picker.click();
    const otherModel = page.getByRole('button', { name: 'Test model', exact: true });
    await expect(otherModel).toBeEnabled();
    if (test.info().project.use.isMobile) await otherModel.tap();
    else {
      // Opening focuses the current model; Test model is listed just before it.
      await expect(page.getByRole('button', { name: 'GPT-6.1 Sol', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(otherModel).toBeFocused();
      await page.keyboard.press('Enter');
    }
    const testModel = page.getByRole('button', { name: 'Choose model, Test model' });
    await expect(testModel).toBeVisible();
    await testModel.click();
    const slider = page.getByRole('slider', { name: 'Reasoning level' });
    // Ultra is filtered out, so the catalog's three levels become Low and High.
    await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
    await expect(slider).toHaveAttribute('max', '1');
    expect((await new AxeBuilder({ page }).include('.model-menu').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: test.info().outputPath('reasoning-menu.png') });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    expect((await new AxeBuilder({ page }).include('.model-menu').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: test.info().outputPath('reasoning-menu-light.png') });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    if (test.info().project.use.isMobile) {
      // The sheet is modal: a tap outside closes it and reaches nothing underneath.
      await page.mouse.click(20, 120);
      await expect(slider).toBeHidden();
      await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
      await testModel.click();
    }
    if (test.info().project.use.isMobile) {
      await page.waitForFunction(() =>
        document
          .querySelector('.model-menu')!
          .getAnimations()
          .every((a) => a.playState !== 'running'),
      );
      const box = (await slider.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width - 10, box.y + box.height / 2);
    } else {
      await slider.focus();
      await page.keyboard.press('ArrowRight');
    }
    await expect(slider).toHaveAttribute('aria-valuetext', 'High');
    await expect(page.getByText('Deeper reasoning')).toBeVisible();
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running'),
    );
    await page.screenshot({ path: test.info().outputPath('reasoning-high.png') });
    // The level name sits on the gradient here; check its contrast in both themes.
    expect((await new AxeBuilder({ page }).include('.model-menu').analyze()).violations).toEqual(
      [],
    );
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    expect((await new AxeBuilder({ page }).include('.model-menu').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: test.info().outputPath('reasoning-high-light.png') });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await page.keyboard.press('Escape');
    await expect(testModel).toHaveAttribute('title', 'Test model · High reasoning');
    const devtools = await context.newCDPSession(page);
    await devtools.send('ServiceWorker.enable');
    await devtools.send('ServiceWorker.stopAllWorkers');
    await devtools.detach();
    const reopened = await context.newPage();
    await page.close();
    await reopened.goto(base);
    await expect(reopened.getByRole('button', { name: 'Choose model, Test model' })).toBeVisible();
    await reopened.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello again');
    await reopened.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(reopened.locator('[data-role=assistant]')).toHaveCount(2);
    await expect(reopened.locator('[data-role=assistant]').last()).toContainText(
      'Browser subscription transport works.',
    );
    expect(requests).toBe(2);
    expect(await reopened.locator('body').innerText()).not.toContain('browser-secret');
    modelListUnavailable = true;
    await reopened.getByRole('button', { name: 'Choose model, Test model' }).click();
    await expect(reopened.getByRole('alert')).toContainText('Try again.');
    modelListUnavailable = false;
    await reopened.getByRole('button', { name: 'Try again' }).click();
    await expect(reopened.getByRole('button', { name: 'Test model', exact: true })).toBeEnabled();
    // Switching back shows the level actually sent (medium), not the catalog default (low).
    await reopened.getByRole('button', { name: 'GPT-6.1 Sol', exact: true }).click();
    await reopened.getByRole('button', { name: 'Choose model, GPT-6.1 Sol' }).click();
    await expect(reopened.getByRole('slider', { name: 'Reasoning level' })).toHaveAttribute(
      'aria-valuetext',
      'Medium',
    );
    await reopened.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running'),
    );
    await reopened.screenshot({ path: test.info().outputPath('reasoning-five-levels.png') });
    await reopened.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await reopened.screenshot({ path: test.info().outputPath('reasoning-five-levels-dark.png') });
  });
}

test('shows the failed request when browser sign-in cannot reach OpenAI', async ({
  page,
  context,
  request,
}) => {
  await request.get(base + 'reset');
  await request.get(base + 'browser-chatgpt');
  let flow: URL;
  await context.route('https://auth.openai.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/authorize')) {
      flow = url;
      await route.fulfill({ contentType: 'text/html', body: '<h1>Sign in fixture</h1>' });
    } else await route.abort('failed');
  });
  await page.goto(base + '?connect=charms');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  const auth = await popup;
  await expect(auth.getByRole('heading', { name: 'Sign in fixture' })).toBeVisible();
  await auth.close();
  await page.getByLabel('Return link from your browser').fill(
    'http://127.0.0.1:1455/auth/callback?' +
      new URLSearchParams({
        code: 'fixture',
        state: flow!.searchParams.get('state')!,
        client_id: 'browser-client',
      }),
  );
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await expect(page.locator('#setup-error')).toHaveText(
    'Could not reach ChatGPT (token exchange). Check your connection, then restart sign-in.',
  );
  await expect(page.getByRole('button', { name: 'Restart sign-in' })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('connection-error.png'), fullPage: true });
});
