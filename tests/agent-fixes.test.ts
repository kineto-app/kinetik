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
  await expect(runtime.appCall('widget', 'publish', {})).rejects.toThrow('Approval required');
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
