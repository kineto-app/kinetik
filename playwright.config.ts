import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'node bin/kinetik.mjs',
      env: { KINETIK_KEEP_ALIVE: '1', KINETIK_OPEN_BROWSER: '0' },
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
    {
      command: 'node tests/fixture-server.mjs',
      url: 'http://127.0.0.1:4174/health',
      reuseExistingServer: false,
    },
  ],
});
