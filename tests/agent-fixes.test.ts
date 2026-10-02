import { expect, test, vi } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ModelRouter } from '../src/models/router';
import { OpenAIModel } from '../src/models/openai';
import type {
  Conversation,
  Model,
  ModelRequest,
  ModelStep,
  ToolDefinition,
} from '../src/core/types';

const read = async (store: Store, id: string) =>
  (await store.get<Conversation>('conversation:' + id))!;
function scripted(steps: ((request: ModelRequest) => ModelStep | Promise<ModelStep>)[]) {
  const seen: ModelRequest[] = [];
  const model: Model = {
    async next(request) {
      seen.push(request);
      const step = steps.shift();
      if (!step) throw new Error('Unexpected model call');
      return step(request);
    },
  };
  return { model, seen };
}
const say = (text: string): ModelStep => ({ type: 'text', text });
function withPublish(runtime: Runtime, ran: unknown[]) {
  const tool: ToolDefinition = {
    description: 'Publish a post',
    inputSchema: { type: 'object' },
    approval: true,
    async execute(input) {
      ran.push(input);
      return 'Published';
    },
  };
  const snapshot = runtime.plugins.snapshot.bind(runtime.plugins);
  runtime.plugins.snapshot = async (builtins, records) => {
    const result = await snapshot(builtins, records);
    result.bindings.publish = { provider: 'social', tool };
    return result;
  };
}

test('bug 1: a tool that needs approval cannot be started as a background job', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const { model, seen } = scripted([
    () => ({
      type: 'tool',
      name: 'background',
      input: { action: 'start', tool: 'publish', input: { title: 'Launch' } },
      callId: 'b1',
    }),
    (request) => say('Result: ' + request.result),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withPublish(runtime, ran);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Publish it in the background');
  await runtime.run(c.id);
  await runtime.background.drain();
  expect(ran).toEqual([]);
  expect(seen[1].result).toContain('needs your approval');
});

test('bug 1: a widget cannot call a tool that needs approval without the user approving', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  const installed = {
    manifest: { id: 'social', name: 'Social', version: '1', apiVersion: 1, entry: 'p.js' },
    source: 'https://example.com/p.json',
    code: '',
    digest: 'd',
    settings: {},
    enabledAt: 1,
  };
  await store.put('plugins', [installed]);
  await store.put('app:widget', {
    plugins: [installed],
    tool: 'social__widget',
    conversationId: c.id,
    provider: 'social',
  });
  const called: string[] = [];
  vi.spyOn(runtime.plugins, 'snapshot').mockResolvedValue({
    bindings: {
      social__widget: {
        provider: 'social',
        tool: {
          description: 'Widget',
          inputSchema: {},
          execute: async () => ({}),
          app: {
            resource: async () => ({ html: '' }),
            call: async (name) => {
              called.push(name);
              return 'Done';
            },
          },
        },
      },
      social__publish: {
        provider: 'social',
        tool: {
          description: 'Publish',
          inputSchema: {},
          approval: true,
          execute: async () => ({}),
        },
      },
    },
    sources: [],
  });
  expect(await runtime.appNeedsApproval('widget', 'publish', {})).toBe(true);
  // A tool the plugin does not expose is treated as needing approval too.
  expect(await runtime.appNeedsApproval('widget', 'hidden', {})).toBe(true);
  await expect(runtime.appCall('widget', 'publish', {})).rejects.toThrow('needs your approval');
  expect(called).toEqual([]);
  expect(await runtime.appCall('widget', 'publish', {}, true)).toBe('Done');
  expect(called).toEqual(['publish']);
});

test('bug 3: a turn keeps the ChatGPT model and reasoning level it started with', async () => {
  const store = new Store(crypto.randomUUID());
  let settings = { model: 'gpt-6.1-sol', effort: 'medium' };
  const pins: unknown[] = [];
  const chatgpt: Model = {
    async next(request) {
      pins.push(request.pin);
      // The user switches model and level while the first step runs.
      settings = { model: 'other-model', effort: 'high' };
      return pins.length === 1
        ? { type: 'tool', name: 'list', input: { path: '/workspace' } }
        : say('Done');
    },
  };
  const router = new ModelRouter(store, chatgpt, scripted([]).model, async () => settings);
  const runtime = new Runtime(store, undefined, router);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Look');
  await runtime.run(c.id);
  expect(pins).toEqual([
    { provider: 'chatgpt', model: 'gpt-6.1-sol', effort: 'medium' },
    { provider: 'chatgpt', model: 'gpt-6.1-sol', effort: 'medium' },
  ]);
});

test('bug 3: the pinned ChatGPT model and level reach the request', async () => {
  let sent: Record<string, unknown> = {};
  const model = new OpenAIModel(
    'https://example.test/responses',
    async () => ({ account: 'a', model: 'current-model' }),
    async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
            },
          }) +
          '\n\n',
      );
    },
  );
  await model.next(
    {
      message: 'Hi',
      instructions: '',
      tools: [],
      pin: { provider: 'chatgpt', model: 'pinned-model', effort: 'high' },
    },
    new AbortController().signal,
  );
  expect(sent.pin).toEqual({ model: 'pinned-model', effort: 'high' });
});

test('bug 4: Stop clears a queued message instead of leaving it marked as queued', async () => {
  const store = new Store(crypto.randomUUID());
  let runtime!: Runtime;
  let id = '';
  const { model } = scripted([
    async () => {
      await runtime.submit(id, 'After that, summarise', undefined, [], 'after');
      await runtime.stop(id);
      return say('First done.');
    },
  ]);
  runtime = new Runtime(store, undefined, model);
  id = (await runtime.create()).id;
  await runtime.submit(id, 'Look at files');
  await runtime.run(id);
  const queued = (await read(store, id)).messages.find((m) => m.text === 'After that, summarise');
  expect(queued?.queue).toBeUndefined();
  expect(queued?.unsent).toBe(true);
});

test('bug 5: reading records by prefix only visits keys with that prefix', async () => {
  const store = new Store(crypto.randomUUID());
  await store.put('a:1', 1);
  await store.put('conversation:1', 2);
  await store.put('z:1', 3);
  const open = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
  expect(await store.entries('conversation:')).toEqual([['conversation:1', 2]]);
  expect(open.mock.calls[0][0]).toBeInstanceOf(IDBKeyRange);
  open.mockRestore();
});

const plugin = (code: string, digest = 'digest-1') => ({
  manifest: { id: 'demo', name: 'Demo', version: '1', apiVersion: 1 as const, entry: 'plugin.js' },
  source: 'https://example.com/demo/plugin.json',
  resolvedSource: 'https://example.com/demo/plugin.json',
  code,
  digest,
  settings: {},
  enabledAt: 1,
});

test('bug 7: stored data is migrated once and versioned', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    modelInput: [{ role: 'user', content: 'Earlier' }],
    turnModel: 'custom' as never,
    plugins: [plugin('return { tools: {} };')],
  }));
  await runtime.recover();
  const migrated = await read(store, c.id);
  expect(await store.get('meta:schema')).toBeGreaterThan(0);
  expect(migrated.modelInput).toBeUndefined();
  expect(migrated.input?.segments).toBe(1);
  expect(migrated.turnModel).toEqual({ provider: 'custom' });
  expect(migrated.plugins?.[0].code).toBe('');
  expect(await store.get('plugin-code:digest-1')).toBe('return { tools: {} };');
});

test('bug 6: a turn and its background jobs keep plugin code once, not in every record', async () => {
  const store = new Store(crypto.randomUUID());
  const code = 'return { tools: {} };';
  await store.put('plugins', [plugin(code, 'digest-2')]);
  const { model } = scripted([() => say('Hi')]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  let pinnedCode: string | undefined;
  const snapshot = runtime.plugins.snapshot.bind(runtime.plugins);
  runtime.plugins.snapshot = async (builtins, records) => {
    pinnedCode = (await read(store, c.id)).plugins?.[0]?.code;
    return snapshot(builtins, records);
  };
  await runtime.submit(c.id, 'Hello');
  await runtime.run(c.id);
  expect(pinnedCode).toBe('');
  expect(await store.get('plugin-code:digest-2')).toBe(code);
});

test('bug 6: deleting a chat removes everything stored for it', async () => {
  const store = new Store(crypto.randomUUID());
  const { model } = scripted([() => say('Hi')]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  const other = await runtime.create();
  const photo = await runtime.stageAttachment(
    c.id,
    'a.jpg',
    new Uint8Array([1]),
    new Uint8Array([2]),
  );
  await runtime.submit(c.id, 'Hello', undefined, [photo.id]);
  await runtime.run(c.id);
  await store.put(`model-archive:${c.id}:1`, []);
  await store.put('app:w1', { conversationId: c.id, plugins: [], tool: 't', provider: 'p' });
  await store.put('app-call:x1', { appId: 'w1', conversationId: c.id, state: 'completed' });
  await store.put('background:j1', { id: 'j1', conversationId: c.id, state: 'completed' });
  await runtime.deleteConversation(c.id);
  const keys = (await store.entries('')).map(([key]) => key);
  expect(keys.filter((key) => key.includes(c.id) || /w1|x1|j1|attachment/.test(key))).toEqual([]);
  expect(keys).toContain('conversation:' + other.id);
});

test('bug 6: startup removes records nothing refers to any more', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    compactions: 2,
    messages: [
      {
        id: 'm',
        role: 'tool',
        text: '',
        createdAt: 0,
        file: { path: '/a', name: 'a', snapshotId: 'kept' },
      },
    ],
  }));
  await store.put(`model-archive:${c.id}:1`, []);
  await store.put(`model-archive:${c.id}:2`, []);
  await store.put('shared-file:kept', new Uint8Array([1]));
  await store.put('shared-file:orphan', new Uint8Array([1]));
  await store.put('attachment-preview:orphan', new Uint8Array([1]));
  await store.put('app-call:done', { state: 'completed' });
  await store.put('app-call:open', { state: 'pending', conversationId: c.id, name: 'save' });
  await store.put('background:old', {
    id: 'old',
    state: 'completed',
    delivered: true,
    startedAt: old,
  });
  await store.put('background:new', {
    id: 'new',
    state: 'completed',
    delivered: true,
    startedAt: Date.now(),
  });
  await store.put('plugin-code:orphan', 'code');
  await store.put('plugins', [plugin('code', 'current')]);
  await store.put('skills:demo:current:s', { revision: '1', skills: [] });
  await store.put('skills:demo:old:s', { revision: '1', skills: [] });
  await runtime.recover();
  const keys = (await store.entries('')).map(([key]) => key);
  expect(keys).toContain(`model-archive:${c.id}:2`);
  expect(keys).not.toContain(`model-archive:${c.id}:1`);
  expect(keys).toContain('shared-file:kept');
  expect(keys).toContain('app-call:open');
  expect(keys).toContain('background:new');
  expect(keys).toContain('skills:demo:current:s');
  for (const gone of [
    'shared-file:orphan',
    'attachment-preview:orphan',
    'app-call:done',
    'background:old',
    'plugin-code:orphan',
    'skills:demo:old:s',
  ])
    expect(keys).not.toContain(gone);
});

test('bug 7: migrations interrupted by a restart run again without changing the result', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    modelInput: [{ role: 'user', content: 'Earlier' }],
    plugins: [plugin('code')],
  }));
  await runtime.recover();
  const once = await read(store, c.id);
  // A worker killed before saving the version runs every migration again.
  await store.put('meta:schema', 0);
  await new Runtime(store).recover();
  const twice = await read(store, c.id);
  expect(twice.input?.segments).toBe(once.input?.segments);
  expect(twice.plugins).toEqual(once.plugins);
  expect(await store.get('meta:schema')).toBe(4);
});

test('bug 6: deleting one chat never touches files another chat still uses', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const a = await runtime.create();
  const b = await runtime.create();
  await store.put('shared-file:other', new Uint8Array([1]));
  const staged = await runtime.stageAttachment(
    b.id,
    'b.jpg',
    new Uint8Array([1]),
    new Uint8Array([2]),
  );
  await runtime.deleteConversation(a.id);
  const keys = (await store.entries('')).map(([key]) => key);
  expect(keys).toContain('shared-file:other');
  expect(keys).toContain('attachment-bytes:' + staged.id);
  expect(keys).toContain('attachment-preview:' + staged.id);
});

test('bug 7: a failing migration or sweep never stops the app from starting', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  await store.put('app-call:orphan', { state: 'pending', conversationId: 'gone', name: 'x' });
  vi.spyOn(store, 'keys').mockRejectedValueOnce(new Error('disk error'));
  await runtime.recover();
  expect((await store.get<{ state: string }>('app-call:orphan'))?.state).toBe('unknown');
});

test('bug 3: ChatGPT compaction uses the model the turn pinned', async () => {
  const sent: unknown[] = [];
  const model = new OpenAIModel(
    'https://example.test/responses',
    async () => ({ account: 'a', model: 'current-model' }),
    fetch,
    async (_account, _input, _signal, pin) => {
      sent.push(pin);
      return [{ type: 'compaction' }];
    },
  );
  await model.compact(
    [],
    { provider: 'chatgpt', model: 'pinned-model' },
    new AbortController().signal,
  );
  expect(sent).toEqual([{ provider: 'chatgpt', model: 'pinned-model' }]);
});
