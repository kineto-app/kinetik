import { spawnSync } from 'node:child_process';

if (!process.env.KINETIK_SIGNING_PROPERTIES)
  throw new Error(
    'Set KINETIK_SIGNING_PROPERTIES to your release signing properties file outside the repo.',
  );
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
  ],
  { stdio: 'inherit', env: process.env },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
