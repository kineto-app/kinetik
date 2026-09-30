import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [version, minShellVersion, base] = process.argv.slice(2);
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!semver.test(version ?? '') || !semver.test(minShellVersion ?? '') || !base)
  throw new Error('Usage: npm run package:native-update -- VERSION MIN_SHELL HTTPS_BASE_URL');
const baseURL = new URL(base.endsWith('/') ? base : base + '/');
if (baseURL.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(baseURL.hostname))
  throw new Error('Use HTTPS for a published update feed.');
const key = process.env.KINETIK_UPDATE_SIGNING_KEY;
if (!key)
  throw new Error('Set KINETIK_UPDATE_SIGNING_KEY to a private minisign key outside the repo.');
const output = resolve('release', 'frontend', version);
await mkdir(output, { recursive: true });
const filename = `bundle-${version}.tar.gz`;
execFileSync(
  'tar',
  [
    '--format=ustar',
    '-czf',
    resolve(output, filename),
    '-C',
    resolve('dist-native'),
    ...(await readdir('dist-native')).sort(),
  ],
  {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  },
);
const archive = await readFile(resolve(output, filename));
const manifest = resolve(output, 'manifest.json');
await writeFile(
  manifest,
  JSON.stringify(
    {
      version,
      createdAt: new Date().toISOString(),
      minShellVersion,
      archive: {
        url: new URL(filename, baseURL).href,
        sha256: createHash('sha256').update(archive).digest('hex'),
        size: archive.length,
      },
    },
    null,
    2,
  ) + '\n',
);
execFileSync('minisign', ['-S', '-s', key, '-m', manifest], { stdio: 'inherit' });
console.log(`Signed update: ${output}`);
