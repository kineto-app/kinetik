import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = resolve('scripts/package-native-update.mjs');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kinetik-update-test-'));
  roots.push(root);
  await mkdir(join(root, 'dist-native'));
  await writeFile(join(root, 'dist-native/index.html'), '<!doctype html><title>Kinetik</title>');
  return root;
}
function run(root: string, args = ['1.2.0', '1.0.0', '2', 'https://example.com/updates/']) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}
test('packages an unsigned tar.gz release with exact size, hash and data format', async () => {
  const root = await fixture();
  const result = run(root);
  expect(result.status).toBe(0);
  const release = JSON.parse(result.stdout);
  expect(release).toMatchObject({
    version: '1.2.0',
    minShellVersion: '1.0.0',
    dataFormat: 2,
    urgent: false,
    rollout: 100,
  });
  const bytes = await readFile(join(root, 'release/frontend/1.2.0/bundle-1.2.0.tar.gz'));
  expect(release.archive).toEqual({
    url: 'https://example.com/updates/bundle-1.2.0.tar.gz',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  expect(
    JSON.parse(await readFile(join(root, 'release/frontend/1.2.0/release.json'), 'utf8')),
  ).toEqual(release);
});
test('rejects invalid versions, formats, HTTP URLs and symlinks', async () => {
  const root = await fixture();
  for (const args of [
    ['../escape', '1.0.0', '1', 'https://example.com/'],
    ['1.0.0', '1.0.0', '-1', 'https://example.com/'],
    ['1.0.0', '1.0.0', '1.5', 'https://example.com/'],
    ['1.0.0', '1.0.0', '1', 'http://localhost/'],
  ])
    expect(run(root, args).status).not.toBe(0);
  await symlink('index.html', join(root, 'dist-native/link.html'));
  expect(run(root).status).not.toBe(0);
});
