import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.env.KINETIK_SIGNING_PROPERTIES)
  throw new Error(
    'Set KINETIK_SIGNING_PROPERTIES to your release signing properties file outside the repo.',
  );
const config = {};
const { KINETIK_UPDATE_URL: manifestUrl, KINETIK_UPDATE_PUBLIC_KEY: publicKey } = process.env;
if (manifestUrl || publicKey) {
  if (!manifestUrl || !publicKey || new URL(manifestUrl).protocol !== 'https:')
    throw new Error('Set both an HTTPS KINETIK_UPDATE_URL and KINETIK_UPDATE_PUBLIC_KEY.');
  config.plugins = { 'hot-update': { enabled: true, manifestUrl, pubkeys: [publicKey] } };
}
const temporary = await mkdtemp(join(tmpdir(), 'kinetik-build-'));
try {
  const path = join(temporary, 'tauri-build.json');
  await writeFile(path, JSON.stringify(config));
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/@tauri-apps/cli/tauri.js',
      'android',
      'build',
      '--apk',
      '--ci',
      '--target',
      process.env.KINETIK_ANDROID_TARGET ?? 'aarch64',
      '--config',
      path,
    ],
    { stdio: 'inherit', env: process.env },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
