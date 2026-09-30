import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Run after `npm run check`: package the exact build exercised by browser tests.
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (
  execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
  }).trim()
)
  throw new Error('Commit source changes before packaging a release.');
const { build, revision: builtRevision } = JSON.parse(await readFile('dist/version.json', 'utf8'));
if (builtRevision !== revision)
  throw new Error('Run the checks and build at the current commit before packaging.');
await rm('release', { recursive: true, force: true });
await mkdir('release', { recursive: true });
await cp('dist', 'release/kinetik-oss', { recursive: true });
await cp('LICENSE', 'release/kinetik-oss/LICENSE.txt');
const files = {};
for (const entry of await readdir('release/kinetik-oss', {
  recursive: true,
  withFileTypes: true,
})) {
  if (entry.isDirectory()) continue;
  if (!entry.isFile()) throw new Error('Release assets must be regular files.');
  const path = join(entry.parentPath, entry.name);
  const relative = path.slice('release/kinetik-oss/'.length).replaceAll('\\', '/');
  files[relative] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
await writeFile(
  'release/kinetik-oss.lock.json',
  JSON.stringify(
    {
      repository: 'https://github.com/kineto-app/kinetik.git',
      revision,
      build,
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Packaged ${revision} (${build}) in release/`);
