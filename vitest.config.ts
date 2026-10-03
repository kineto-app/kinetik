import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 15000,
    projects: [
      {
        extends: true,
        test: {
          name: 'browser-storage',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/node/**'],
          setupFiles: ['tests/setup.ts'],
        },
      },
      // The agent core with no browser globals, as evals run it.
      { extends: true, test: { name: 'node', include: ['tests/node/**/*.test.ts'] } },
    ],
  },
});
