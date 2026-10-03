import { loadChat } from './chat';
import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import type { Conversation, InstalledPlugin } from '../src/core/types';

test('attachments survive reopening and reach model context with readable bytes', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const chat = await runtime.create();
  const file = await runtime.stageAttachment(
    chat.id,
    'notes.txt',
    new TextEncoder().encode('hello'),
  );
  let history: unknown;
  const reopened = new Runtime(store, undefined, {
    async next(request) {
      history = request.history;
      return { type: 'text', text: 'Read your attachment.' };
    },
  });
  await reopened.submit(chat.id, '', undefined, [file.id]);
  await reopened.run(chat.id);
  const saved = (await loadChat(store, chat.id))!;
  expect(saved.attachments).toEqual([]);
  expect(saved.messages[0].attachments?.[0].name).toBe('notes.txt');
  const path = saved.messages[0].attachments![0].path;
  expect(new TextDecoder().decode(await reopened.exportFile(path))).toBe('hello');
  expect(JSON.stringify(history)).toContain(path);
  expect(await store.get('attachment-bytes:' + file.id)).toBeUndefined();
});

test('failed remote upload retains staged file; retry sends bytes to the active provider', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const chat = await runtime.create();
  const record: InstalledPlugin = {
    manifest: { id: 'remote', name: 'Remote', version: '1', apiVersion: 1, entry: 'plugin.js' },
    source: 'https://example.com/plugin.json',
    resolvedSource: 'https://example.com/plugin.json',
    digest: 'remote',
    enabledAt: 1,
    settings: { state: 'offline' },
    code: `return { tools: { write: { description: 'Remote write', inputSchema: {type:'object'}, execute: async()=>{} } }, replacements: {write:'write'}, files: {upload: async (file) => { if (host.settings.state !== 'online') throw Error('Offline'); globalThis.uploadedAttachment = Array.from(file.bytes); return {path:'files/' + file.name}; }} }`,
  };
  await store.put('plugins', [record]);
  const file = await runtime.stageAttachment(chat.id, 'photo.png', new Uint8Array([0, 1, 255]));
  await expect(runtime.submit(chat.id, 'Look at this', undefined, [file.id])).rejects.toThrow(
    'Offline',
  );
  expect((await runtime.conversations())[0].messages).toHaveLength(0);
  expect((await runtime.conversations())[0].attachments).toHaveLength(1);
  await store.put('plugins', [{ ...record, settings: { state: 'online' } }]);
  try {
    await runtime.submit(chat.id, 'Look at this', undefined, [file.id]);
    expect((globalThis as any).uploadedAttachment).toEqual([0, 1, 255]);
    expect((await runtime.conversations())[0].messages[0].attachments?.[0]).toMatchObject({
      path: 'files/photo.png',
      provider: 'remote',
    });
    await expect(runtime.exportFile('/workspace/photo.png')).rejects.toThrow();
  } finally {
    delete (globalThis as any).uploadedAttachment;
  }
});

test('removed files cannot be sent and their bytes are deleted', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const chat = await runtime.create();
  const file = await runtime.stageAttachment(chat.id, 'remove.txt', new Uint8Array([1]));
  await runtime.removeAttachment(chat.id, file.id);
  await expect(runtime.submit(chat.id, 'No file', undefined, [file.id])).rejects.toThrow();
  expect(await store.get('attachment-bytes:' + file.id)).toBeUndefined();
});

test('sent attachments survive workspace transfer with model context', async () => {
  const { exportArchive, parseArchive } = await import('../src/core/archive');
  const source = new Store(crypto.randomUUID());
  const runtime = new Runtime(source);
  const chat = await runtime.create();
  const file = await runtime.stageAttachment(
    chat.id,
    'portable.txt',
    new TextEncoder().encode('portable'),
  );
  await runtime.submit(chat.id, 'Read this', undefined, [file.id]);
  const records = await parseArchive(await exportArchive(source));
  const restored = records.find(([key]) => key === 'conversation:' + chat.id)![1] as Conversation;
  expect(restored.messages[0].attachments![0].name).toBe('portable.txt');
  expect(restored.modelInput![0].content).toContain(restored.messages[0].attachments![0].path);
});

test('image previews outlive sending and leave with removed staged files', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const chat = await runtime.create();
  const preview = new Uint8Array([255, 216, 255]);
  const kept = await runtime.stageAttachment(chat.id, 'kept.jpg', new Uint8Array([1]), preview);
  const removed = await runtime.stageAttachment(
    chat.id,
    'removed.jpg',
    new Uint8Array([2]),
    preview,
  );
  await expect(
    runtime.stageAttachment(
      chat.id,
      'big.jpg',
      new Uint8Array([3]),
      new Uint8Array(2 * 1024 * 1024 + 1),
    ),
  ).rejects.toThrow('Invalid file preview.');
  await runtime.removeAttachment(chat.id, removed.id);
  expect(await runtime.attachmentPreview(removed.id)).toBeUndefined();
  await runtime.submit(chat.id, '', undefined, [kept.id]);
  expect(await store.get('attachment-bytes:' + kept.id)).toBeUndefined();
  expect(await runtime.attachmentPreview(kept.id)).toEqual(preview);
});
