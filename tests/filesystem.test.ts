import { expect, test } from 'vitest';
import { Bash } from 'just-bash/browser';
import { Store } from '../src/browser/store';
import { createFilesystem } from '../src/browser/filesystem';

test('shell and direct tools share durable binary data, directories, symlinks and hard links', async () => {
  const store = new Store(crypto.randomUUID());
  const { fs } = await createFilesystem(store);
  const bash = new Bash({ fs, cwd: '/workspace', commands: ['echo', 'cat', 'mkdir', 'ln', 'mv'] });
  const outcome = await bash.exec(
    'mkdir notes; echo hello > notes/a; ln notes/a notes/b; ln -s notes/a shortcut',
  );
  expect(outcome.exitCode, outcome.stderr).toBe(0);
  await fs.writeFile('/workspace/bytes', new Uint8Array([0, 255, 128, 10]));
  const restored = (await createFilesystem(store)).fs;
  expect(await restored.readFile('/workspace/shortcut')).toBe('hello\n');
  expect(await restored.readFileBuffer('/workspace/bytes')).toEqual(
    new Uint8Array([0, 255, 128, 10]),
  );
  expect((await restored.stat('/workspace/notes/a')).identity).toBe(
    (await restored.stat('/workspace/notes/b')).identity,
  );
  await restored.rm('/workspace/notes/b');
  expect(await restored.readFile('/workspace/notes/a')).toBe('hello\n');
});
test('parallel commands preserve unrelated files and appends', async () => {
  const { fs } = await createFilesystem(new Store(crypto.randomUUID()));
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => fs.writeFile(`/workspace/file-${i}`, String(i))),
  );
  await Promise.all(Array.from({ length: 12 }, () => fs.appendFile('/workspace/shared', 'x')));
  expect((await fs.readdir('/workspace')).length).toBe(13);
  expect(await fs.readFile('/workspace/shared')).toBe('x'.repeat(12));
});
test('failed edits do not change data; unique edits are atomic', async () => {
  const workspace = await createFilesystem(new Store(crypto.randomUUID()));
  await workspace.fs.writeFile('/workspace/a', 'same same');
  await expect(workspace.edit('/workspace/a', 'same', 'bad')).rejects.toThrow('exactly one');
  expect(await workspace.fs.readFile('/workspace/a')).toBe('same same');
  await workspace.edit('/workspace/a', 'same same', 'good');
  expect(await workspace.fs.readFile('/workspace/a')).toBe('good');
});
