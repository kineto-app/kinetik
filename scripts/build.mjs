import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const output = process.argv.includes('--native') ? 'dist-native' : 'dist';
await viteBuild({ base: './', build: { target: 'es2022', outDir: output } });
const files = (await readdir(output, { recursive: true }))
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => /\.(js|css|html|svg|png|json|webmanifest)$/.test(path));
const hash = createHash('sha256');
for (const file of files) hash.update(await readFile(output + '/' + file));
hash.update(await readFile('src/sw.ts'));
// All worker source/dependency changes must produce a fresh cache namespace too.
hash.update(String(Date.now()));
const buildId = hash.digest('hex').slice(0, 12);
await build({
  entryPoints: ['src/sw.ts'],
  outfile: output + '/sw.js',
  bundle: true,
  platform: 'browser',
  alias: { 'node:zlib': fileURLToPath(new URL('../src/browser/no-zlib.ts', import.meta.url)) },
  target: 'es2022',
  format: 'iife',
  minify: true,
  legalComments: 'external',
  define: {
    __PRECACHE__: JSON.stringify(files),
    __BUILD_ID__: JSON.stringify(buildId),
  },
});
// Ship license texts for the installed production dependency tree with the bundle.
let revision = null;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // A source archive can still build, but cannot be packaged as a verified Git revision.
}
await writeFile(output + '/version.json', JSON.stringify({ build: buildId, revision }));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
let licenses = 'Runtime dependency licenses for Kinetik OSS\n';
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path || meta.dev) continue;
  try {
    const names = await readdir(path);
    const texts = names.filter((name) => /^(licen[sc]e|notice)(\.|$)/i.test(name));
    licenses += `\n\n=== ${path} ${meta.version} (${meta.license ?? 'see package'}) ===\n`;
    for (const name of texts) licenses += await readFile(`${path}/${name}`, 'utf8');
  } catch {
    /* Optional packages absent on this platform are not bundled. */
  }
}
await writeFile(output + '/THIRD_PARTY_LICENSES.txt', licenses);
