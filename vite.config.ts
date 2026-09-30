import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  define: {
    __NATIVE_BUILD__: JSON.stringify(
      process.argv.includes('--native') || Boolean(process.env.TAURI_ENV_PLATFORM),
    ),
    __NATIVE_CONFIG__: process.env.KINETIK_NATIVE_CONFIG
      ? readFileSync(process.env.KINETIK_NATIVE_CONFIG, 'utf8')
      : JSON.stringify({ connections: {} }),
  },
  resolve: {
    alias: { 'node:zlib': fileURLToPath(new URL('./src/browser/no-zlib.ts', import.meta.url)) },
  },
  server: { host: process.env.TAURI_DEV_HOST || '127.0.0.1', strictPort: true },
  clearScreen: false,
});
