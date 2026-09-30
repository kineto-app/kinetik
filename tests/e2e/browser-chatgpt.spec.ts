import { test, expect } from '@playwright/test';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
const base = 'http://127.0.0.1:4174/onboarding/';
for (const relay of [false, true]) {
  test(`browser login (${relay ? 'relay' : 'direct'}) drives a worker request, keeps tokens off disk, and ends when worker memory is lost`, async ({
    page,
    context,
    request,
  }) => {
    await request.get(base + 'reset');
    await request.get(base + 'browser-chatgpt' + (relay ? '?relay=1' : ''));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let flow: URL;
    let requests = 0;
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
            access_token: 'browser-secret-access',
            refresh_token: 'browser-secret-refresh',
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
        expect(route.request().headers().authorization).toBe('Bearer browser-secret-access');
        if (route.request().url().endsWith('/models')) {
          await route.fulfill({ json: { models: [{ slug: 'test-model', visibility: 'list' }] } });
          return;
        }
        requests++;
        const body = route.request().postDataJSON();
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        expect(body.model).toBe('test-model');
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
    expect(saved).not.toContain('browser-secret');
    const devtools = await context.newCDPSession(page);
    await devtools.send('ServiceWorker.enable');
    await devtools.send('ServiceWorker.stopAllWorkers');
    await devtools.detach();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello again');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
    expect(requests).toBe(1);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Hello again',
    );
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
