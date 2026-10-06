import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  define: {
    __APP_VERSION__: JSON.stringify(
      JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version,
    ),
    // Native apps ship with Charms; a distributor's file replaces the whole configuration.
    __NATIVE_CONFIG__: readFileSync(
      process.env.KINETIK_NATIVE_CONFIG ?? 'native.config.json',
      'utf8',
    ),
  },
  resolve: {
    alias: { 'node:zlib': fileURLToPath(new URL('./src/browser/no-zlib.ts', import.meta.url)) },
  },
  server: { host: process.env.TAURI_DEV_HOST || '127.0.0.1', strictPort: true },
  clearScreen: false,
});
