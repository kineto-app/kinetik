import { expect, test } from 'vitest';
import { Store } from '../src/browser/store';
import { createFilesystem } from '../src/browser/filesystem';
import { exportArchive, parseArchive } from '../src/core/archive';
import { digest } from '../src/plugins/loader';

test('workspace transfer excludes credentials and execution state and preserves binary files', async () => {
  const source = new Store(crypto.randomUUID());
  const { fs } = await createFilesystem(source);
  await fs.writeFile('/workspace/binary', new Uint8Array([0, 255, 128]));
  await source.put('connection-token:charms', { access: 'PRIVATE-placeholder-access' });
  await source.put('connection-pending:charms', { verifier: 'PRIVATE-placeholder-verifier' });
  const plugin = {
    manifest: { id: 'example', name: 'Example', version: '1', apiVersion: 1, entry: 'index.js' },
    source: 'https://example.org/plugin.json',
    resolvedSource: 'https://example.org/plugin.json',
    code: 'export default () => ({})',
    enabledAt: 1,
    settings: { token: 'PRIVATE-placeholder-plugin' },
  };
  await source.put('plugins', [{ ...plugin, digest: await digest(plugin.code) }]);
  await source.put('conversation:one', {
    id: 'one',
    title: 'Chat',
    updatedAt: 1,
    status: 'running',
    pending: ['pending'],
    plugins: [plugin],
    call: { input: 'PRIVATE-CALL' },
    messages: [{ id: 'm1', role: 'user', text: 'Hello', createdAt: 1 }],
  });
  await source.put('automations', {
    items: [
      {
        id: 'job',
        kind: 'job',
        prompt: 'Summarize',
        maxRuns: 10,
        status: 'active',
        intervalMs: 60000,
      },
    ],
    events: ['PRIVATE-EVENT'],
  });
  const text = await exportArchive(source);
  expect(text).not.toContain('PRIVATE-');
  const target = new Store(crypto.randomUUID());
  await target.put('connection-token:charms', { access: 'placeholder-device-token' });
  await target.put('conversation:old', {});
  await target.replace(await parseArchive(text), (key) => key.startsWith('connection'));
  expect(await target.get('conversation:old')).toBeUndefined();
  expect(await target.get('connection-token:charms')).toEqual({
    access: 'placeholder-device-token',
  });
  expect(await (await createFilesystem(target)).fs.readFileBuffer('/workspace/binary')).toEqual(
    new Uint8Array([0, 255, 128]),
  );
  expect(await target.get('conversation:one')).toMatchObject({
    status: 'idle',
    pending: [],
    modelInput: [{ role: 'user', content: 'Hello' }],
  });
  expect(await target.get('plugins')).toMatchObject([{ enabledAt: null, settings: {} }]);
  expect(await target.get('automations')).toMatchObject({
    items: [{ status: 'paused' }],
    events: [],
  });
});

test('invalid and modified archives are rejected before writes', async () => {
  await expect(parseArchive('{"format":"other"}')).rejects.toThrow('not a supported');
  const source = new Store(crypto.randomUUID());
  await (await createFilesystem(source)).fs.writeFile('/workspace/a', 'original');
  const original = JSON.parse(await exportArchive(source));
  original.filesystem.entries[0].path = '/workspace/../escape';
  await expect(parseArchive(JSON.stringify(original))).rejects.toThrow('Invalid file path');
  const duplicate = JSON.parse(await exportArchive(source));
  duplicate.filesystem.entries.push(duplicate.filesystem.entries[0]);
  await expect(parseArchive(JSON.stringify(duplicate))).rejects.toThrow('Invalid file path');
  expect(await (await createFilesystem(source)).fs.readFile('/workspace/a')).toBe('original');
});
