import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [version, minShellVersion, format, base] = process.argv.slice(2);
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const dataFormat = Number(format);
if (
  !semver.test(version ?? '') ||
  !semver.test(minShellVersion ?? '') ||
  !/^(0|[1-9]\d*)$/.test(format ?? '') ||
  !Number.isSafeInteger(dataFormat) ||
  dataFormat > 0xffffffff ||
  !base
)
  throw new Error(
    'Usage: npm run package:native-update -- VERSION MIN_SHELL DATA_FORMAT HTTPS_BASE_URL',
  );
const baseURL = new URL(base.endsWith('/') ? base : base + '/');
if (
  baseURL.protocol !== 'https:' ||
  baseURL.username ||
  baseURL.password ||
  baseURL.search ||
  baseURL.hash
)
  throw new Error('Use an HTTPS archive base URL without credentials, query or fragment.');
const output = resolve('release', 'frontend', version);
await mkdir(output, { recursive: true });
await readFile('dist-native/index.html');
const entries = await readdir('dist-native', { recursive: true });
if (entries.length > 10000) throw new Error('Bundle exceeds 10,000 entries.');
let unpackedSize = 0;
for (const file of entries) {
  if (/[\\:]/.test(file)) throw new Error('Bundle contains an unsupported path.');
  const stat = await lstat(join('dist-native', file));
  if (stat.isFile()) unpackedSize += stat.size;
  if (unpackedSize > 256 * 1024 * 1024) throw new Error('Bundle exceeds 256 MiB extracted.');
  if (!stat.isFile() && !stat.isDirectory())
    throw new Error('Bundle must contain only regular files and directories.');
}
const filename = `bundle-${version}.tar.gz`;
execFileSync(
  'tar',
  [
    '--format=ustar',
    '-czf',
    resolve(output, filename),
    '-C',
    resolve('dist-native'),
    '--',
    ...(await readdir('dist-native')).sort(),
  ],
  {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  },
);
const archive = await readFile(resolve(output, filename));
if (archive.length > 64 * 1024 * 1024) throw new Error('Archive exceeds 64 MiB.');
const release = {
  version,
  minShellVersion,
  dataFormat,
  urgent: false,
  rollout: 100,
  archive: {
    url: new URL(filename, baseURL).href,
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.length,
  },
};
const text = JSON.stringify(release, null, 2) + '\n';
await writeFile(resolve(output, 'release.json'), text);
process.stdout.write(text);
