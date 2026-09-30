import { expect, test } from 'vitest';
import { Store } from '../src/browser/store';
import { Runtime } from '../src/core/runtime';
import type { Conversation, InstalledPlugin } from '../src/core/types';
const waitFor = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Condition timed out');
};
const read = async (store: Store, id: string) =>
  (await store.get<Conversation>('conversation:' + id))!;
const plugin = (id: string, enabledAt: number, code: string): InstalledPlugin => ({
  manifest: { id, name: id, version: '1', apiVersion: 1, entry: 'plugin.js' },
  source: 'https://example.com/plugin.json',
  resolvedSource: 'https://example.com/plugin.json',
  code,
  digest: id,
  enabledAt,
  settings: {},
});

test('parallel conversations execute independently with persisted results', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const a = await runtime.create(),
    b = await runtime.create();
  await runtime.submit(a.id, '/exec sleep 0.3; echo slow > slow.txt');
  await runtime.submit(b.id, '/write /workspace/fast.txt\nfast');
  const run = runtime.run(a.id);
  await runtime.run(b.id);
  expect((await read(store, b.id)).status).toBe('idle');
  await run;
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/fast.txt'))).toBe('fast');
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/slow.txt'))).toBe('slow\n');
});
test('incoming messages steer at a tool boundary', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec sleep 0.3; echo original');
  const run = runtime.run(c.id);
  await waitFor(async () => (await read(store, c.id)).call?.state === 'pending');
  await runtime.submit(c.id, '/write /workspace/steered\nnew direction');
  await run;
  expect((await read(store, c.id)).messages.some((m) => m.text.includes('tool boundary'))).toBe(
    true,
  );
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/steered'))).toBe(
    'new direction',
  );
});
test('stop leaves interrupted effects explicit and does not retry them', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec sleep 10; echo should-not-run > late');
  const run = runtime.run(c.id);
  await waitFor(async () => (await read(store, c.id)).call?.state === 'pending');
  await runtime.stop(c.id);
  await run;
  expect((await read(store, c.id)).status).toBe('needs_review');
  await runtime.resolve(c.id, false);
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('idle');
  await expect(runtime.exportFile('/workspace/late')).rejects.toThrow();
});
test('worker recovery never reissues an uncertain tool', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/write /workspace/double\ndanger');
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    activeMessage: value!.pending[0],
    pending: [],
    call: {
      id: 'call',
      name: 'write',
      provider: 'local',
      input: { path: '/workspace/double', content: 'danger' },
      state: 'pending',
    },
  }));
  const restarted = new Runtime(store);
  await restarted.recover();
  await restarted.run(c.id);
  expect((await read(store, c.id)).status).toBe('needs_review');
  await expect(restarted.exportFile('/workspace/double')).rejects.toThrow();
});
test('last enabled plugin wins, disable restores prior provider, read_skill stays native', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const code = (value: string) =>
    `return {tools:{remote:{description:'remote',inputSchema:{type:'object'},async execute(){return '${value}'}}},replacements:{exec:'remote'}}`;
  await store.put('plugins', [
    plugin('first', 1, code('first')),
    plugin('second', 2, code('second')),
  ]);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec echo ignored');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('second');
  await runtime.plugins.enable('second', false);
  await runtime.submit(c.id, '/exec echo ignored');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('first');
  await runtime.submit(c.id, '/read_skill skills/local/workspace/SKILL.md');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toContain('Local workspace');
});
test('a failed plugin does not fall back to local shell', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  await store.put('plugins', [
    plugin(
      'broken',
      1,
      "return {tools:{remote:{description:'remote',inputSchema:{type:'object'},async execute(){throw new Error('offline')}}},replacements:{exec:'remote'}}",
    ),
  ]);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec echo unsafe > fallback');
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('needs_review');
  await expect(runtime.exportFile('/workspace/fallback')).rejects.toThrow();
});

test('an unavailable plugin during recovery does not block the workspace or repeat its tool', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec remote operation');
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    activeMessage: value!.pending[0],
    pending: [],
    plugins: [plugin('offline', 1, "throw new Error('provider offline')")],
    call: {
      id: 'pending',
      name: 'exec',
      provider: 'offline',
      input: {},
      state: 'pending',
      operationId: 'remote-id',
    },
  }));
  await new Runtime(store).recover();
  expect((await read(store, c.id)).status).toBe('needs_review');
  expect((await read(store, c.id)).call?.state).toBe('unknown');
  expect((await runtime.create()).status).toBe('idle');
});

test('a crash immediately after Stop still exposes the pending tool for review', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    status: 'stopped',
    call: { id: 'pending', name: 'write', provider: 'local', input: {}, state: 'pending' },
  }));
  await new Runtime(store).recover();
  expect((await read(store, c.id)).status).toBe('needs_review');
  expect((await read(store, c.id)).call?.state).toBe('unknown');
});

test('resolving while provider cancellation finishes resumes the conversation', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  await store.put('plugins', [
    plugin(
      'remote',
      1,
      `return {
    tools: { remote: { description: 'remote', inputSchema: {type: 'object'},
      async execute(input, context) { await context.checkpoint('remote-id'); return new Promise(() => {}); },
      async cancel() { await new Promise(resolve => setTimeout(resolve, 100)); }
    } }, replacements: { exec: 'remote' }
  }`,
    ),
  ]);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec remote');
  const running = runtime.run(c.id);
  await waitFor(async () => (await read(store, c.id)).call?.operationId === 'remote-id');
  await runtime.stop(c.id);
  await waitFor(async () => (await read(store, c.id)).status === 'needs_review');
  await runtime.resolve(c.id, false);
  await runtime.run(c.id);
  await running;
  expect((await read(store, c.id)).status).toBe('idle');
});
