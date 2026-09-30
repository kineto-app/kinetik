import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await viteBuild({ base: './', build: { target: 'es2022' } });
const files = (await readdir('dist', { recursive: true })).filter((p) =>
  /\.(js|css|html|svg|png|json|webmanifest)$/.test(p),
);
const hash = createHash('sha256');
for (const file of files) hash.update(await readFile('dist/' + file));
hash.update(await readFile('src/sw.ts'));
// All worker source/dependency changes must produce a fresh cache namespace too.
hash.update(String(Date.now()));
await build({
  entryPoints: ['src/sw.ts'],
  outfile: 'dist/sw.js',
  bundle: true,
  platform: 'browser',
  alias: { 'node:zlib': new URL('../src/browser/no-zlib.ts', import.meta.url).pathname },
  target: 'es2022',
  format: 'iife',
  minify: true,
  legalComments: 'external',
  define: {
    __PRECACHE__: JSON.stringify(files),
    __BUILD_ID__: JSON.stringify(hash.digest('hex').slice(0, 12)),
  },
});
// Ship license texts for the installed production dependency tree with the bundle.
const { writeFile } = await import('node:fs/promises');
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
await writeFile('dist/THIRD_PARTY_LICENSES.txt', licenses);
