import { expect, test, vi } from 'vitest';
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
  expect((await read(store, c.id)).pending).toEqual([]);
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
    `return {tools:{remote:{description:'remote',inputSchema:{type:'object'},async execute(){return '${value}'}}},replacements:{exec:'remote'},skills:{async sync(){return {revision:'1',skills:[{name:'guide',description:'Provider guide',path:'guide/SKILL.md',content:'Remote provider instructions'}]}}}}`;
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
  await runtime.submit(c.id, '/read_skill skills/first/guide/SKILL.md');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toContain('Remote provider instructions');
  await runtime.submit(c.id, '/skills');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).not.toContain('skills/local/workspace');
  await runtime.plugins.enable('first', false);
  await runtime.submit(c.id, '/skills');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toContain('skills/local/workspace');
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

test('local SKILL.md metadata refreshes before the next message', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const conversation = await runtime.create();
  await runtime.submit(
    conversation.id,
    '/exec mkdir -p /workspace/skills/test; printf "---\\nname: test\\ndescription: Local instructions\\n---\\nDo useful work" > /workspace/skills/test/SKILL.md',
  );
  await runtime.run(conversation.id);
  await runtime.submit(conversation.id, '/skills');
  await runtime.run(conversation.id);
  expect((await read(store, conversation.id)).messages.at(-1)?.text).toContain(
    'test: Local instructions',
  );
  await runtime.submit(conversation.id, '/read_skill /workspace/skills/test/SKILL.md');
  await runtime.run(conversation.id);
  expect((await read(store, conversation.id)).messages.at(-1)?.text).toContain('Do useful work');
});

test('steering during inference discards the stale action and keeps every queued message in history', async () => {
  const store = new Store(crypto.randomUUID());
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runtime = new Runtime(store, undefined, {
    async next(request) {
      if (++calls === 1) {
        entered();
        await held;
        return {
          type: 'tool',
          name: 'write',
          input: { path: '/workspace/stale', content: 'wrong' },
        };
      }
      expect(request.history?.map((item) => item.content)).toEqual([
        'original',
        'stop that',
        'new direction',
      ]);
      return { type: 'text', text: 'Followed the new direction.' };
    },
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'original');
  const running = runtime.run(c.id);
  await waiting;
  await runtime.submit(c.id, 'stop that');
  await runtime.submit(c.id, 'new direction');
  release();
  await running;
  expect(calls).toBe(2);
  expect((await read(store, c.id)).pending).toEqual([]);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Followed the new direction.');
  await expect(runtime.exportFile('/workspace/stale')).rejects.toThrow();
});

test('file browser lists nested files and does not follow directory symlinks', async () => {
  const runtime = new Runtime(new Store(crypto.randomUUID()));
  const c = await runtime.create();
  await runtime.submit(
    c.id,
    '/exec mkdir -p folder; printf hello > folder/note.txt; ln -s /workspace folder/loop',
  );
  await runtime.run(c.id);
  const files = await runtime.files();
  expect(files).toContainEqual({ path: '/workspace/folder/note.txt', name: 'note.txt', size: 5 });
  expect(files.some((file) => file.path.includes('/loop/'))).toBe(false);
});

test('foreground tools can request a longer bounded response budget', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    await store.put('plugins', [
      plugin(
        'slow',
        1,
        "return {tools:{remote:{timeoutMs:120000,description:'remote',inputSchema:{type:'object'},async execute(){return 'done'}}},replacements:{exec:'remote'}}",
      ),
    ]);
    const c = await runtime.create();
    await runtime.submit(c.id, '/exec slow command');
    await runtime.run(c.id);
    expect(timeout).toHaveBeenCalledWith(60000);
    expect((await read(store, c.id)).messages.at(-1)?.text).toBe('done');
  } finally {
    timeout.mockRestore();
  }
});

test('returning to the app leaves a live embedded-app call alone', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  const installed = plugin('widget', 1, 'return {}');
  await store.put('plugins', [installed]);
  await store.put('app:widget', {
    plugins: [installed],
    tool: 'widget',
    conversationId: c.id,
    provider: 'widget',
  });
  let finish!: (result: unknown) => void;
  vi.spyOn(runtime.plugins, 'snapshot').mockResolvedValue({
    bindings: {
      widget: {
        provider: 'widget',
        tool: {
          description: 'Widget',
          inputSchema: {},
          execute: async () => ({}),
          app: {
            resource: async () => ({ html: '' }),
            call: () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          },
        },
      },
    },
    sources: [],
  });
  const call = runtime.appCall('widget', 'save', {});
  await waitFor(async () => Boolean(finish));
  await Promise.all([runtime.recover(), runtime.recover()]);
  expect((await read(store, c.id)).messages).toEqual([]);
  finish('Saved');
  await call;
  expect((await read(store, c.id)).messages.map((m) => m.text)).toEqual(['Saved']);
});

test('completed narration stays between tool groups, including after reconnecting', async () => {
  const { ConnectionError } = await import('../src/core/connection-error');
  const store = new Store(crypto.randomUUID());
  let calls = 0;
  const runtime = new Runtime(store, undefined, {
    async next() {
      calls++;
      if (calls === 2) throw new ConnectionError('Disconnected');
      if (calls === 1 || calls === 3)
        return {
          type: 'tool',
          name: 'exec',
          input: { command: 'echo step >> /workspace/actions' },
          narration:
            calls === 1 ? 'I will create the slides.' : 'The draft is ready. I will check it.',
        };
      return { type: 'text', text: 'Done.' };
    },
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Create slides');
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('waiting');
  expect((await read(store, c.id)).messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
  ]);
  await runtime.recover();
  await runtime.run(c.id);
  const messages = (await read(store, c.id)).messages;
  expect(messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
    'tool',
    'assistant',
  ]);
  expect(messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
    'I will create the slides.',
    'The draft is ready. I will check it.',
    'Done.',
  ]);
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/actions'))).toBe(
    'step\nstep\n',
  );
});

test('a transport failure after a remote checkpoint recovers the same operation without user intervention', async () => {
  const store = new Store(crypto.randomUUID());
  let step = 0;
  const runtime = new Runtime(store, undefined, {
    async next(request) {
      if (++step === 1) return { type: 'tool', name: 'exec', input: {} };
      return { type: 'text', text: request.result! };
    },
  });
  const execute = vi.fn(async (_input, context) => {
    await context.checkpoint('existing-job');
    throw new TypeError('Failed to fetch');
  });
  const recover = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ done: false })
    .mockResolvedValueOnce({ done: true, result: 'Saved remote result' });
  vi.spyOn(runtime.plugins, 'snapshot').mockResolvedValue({
    bindings: {
      exec: {
        provider: 'remote',
        tool: { description: 'Remote', inputSchema: {}, execute, recover },
      },
    },
    sources: [],
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Do remote work');
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('waiting');
  await runtime.recover();
  expect((await read(store, c.id)).status).toBe('waiting');
  await runtime.recover();
  expect((await read(store, c.id)).status).toBe('waiting');
  await runtime.recover();
  expect((await read(store, c.id)).status).toBe('queued');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Saved remote result');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(recover.mock.calls.every(([id]) => id === 'existing-job')).toBe(true);
});

test('Stop during a remote recovery check does not restart the conversation', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    status: 'waiting',
    waitingFor: 'connection',
    call: {
      id: 'call',
      name: 'exec',
      provider: 'remote',
      input: {},
      state: 'pending',
      operationId: 'job',
    },
  }));
  let finish!: (value: { done: boolean; result: string }) => void;
  vi.spyOn(runtime.plugins, 'snapshot').mockResolvedValue({
    bindings: {
      exec: {
        provider: 'remote',
        tool: {
          description: 'Remote',
          inputSchema: {},
          execute: async () => {},
          recover: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      },
    },
    sources: [],
  });
  const recovering = runtime.recover();
  await waitFor(async () => Boolean(finish));
  await runtime.stop(c.id);
  finish({ done: true, result: 'Finished after Stop' });
  await recovering;
  expect((await read(store, c.id)).status).toBe('stopped');
});

test('tool receipts retain arguments and unsuccessful command outcomes across reloads', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/exec false');
  await runtime.run(c.id);
  const saved = (await read(store, c.id)).messages.find((item) => item.role === 'tool');
  expect(saved?.activity).toEqual({ input: { command: 'false' }, outcome: 'failed' });
  const restarted = new Runtime(store);
  await restarted.recover();
  expect(
    (await read(store, c.id)).messages.find((item) => item.id === saved?.id)?.activity,
  ).toEqual(saved?.activity);
});
