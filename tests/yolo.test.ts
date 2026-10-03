import { expect, test, vi } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { loadChat, updateChat } from './chat';
import type { Model, ModelStep, ToolDefinition } from '../src/core/types';

const say = (text: string): ModelStep => ({ type: 'text', text });
const scripted = (steps: ModelStep[]): Model => ({ next: async () => steps.shift()! });
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

test('by default a tool marked for approval runs without asking', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const runtime = new Runtime(
    store,
    undefined,
    scripted([
      { type: 'tool', name: 'publish', input: { title: 'Launch' }, callId: 'p' },
      say('Posted.'),
    ]),
  );
  withPublish(runtime, ran);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Publish it');
  await runtime.run(c.id);
  expect(ran).toEqual([{ title: 'Launch' }]);
  const saved = await loadChat(store, c.id);
  expect(saved.status).toBe('idle');
  expect(saved.messages.at(-1)?.text).toBe('Posted.');
});

test('by default memory is saved at once, and the chat shows it', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(
    store,
    undefined,
    scripted([
      { type: 'tool', name: 'remember', input: { text: 'Likes coral.' }, callId: 'r' },
      say('Noted.'),
    ]),
  );
  const c = await runtime.create();
  await runtime.submit(c.id, 'Remember that I like coral');
  await runtime.run(c.id);
  expect(await store.get('memory')).toBe('Likes coral.');
  const saved = await loadChat(store, c.id);
  expect(saved.messages.find((m) => m.role === 'tool')?.text).toBe('Saved to memory.');
  expect(saved.status).toBe('idle');
});

test('by default a widget may call any tool its server exposes, without a card', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  const installed = {
    manifest: { id: 'social', name: 'Social', version: '1', apiVersion: 1 as const, entry: 'p.js' },
    source: 'https://example.com/p.json',
    resolvedSource: 'https://example.com/p.json',
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
            call: async (name) => (called.push(name), 'Done'),
          },
        },
      },
      social__publish: {
        provider: 'social',
        tool: { description: 'Publish', inputSchema: {}, approval: true, execute: async () => 'x' },
      },
    },
    sources: [],
  });
  expect(await runtime.appNeedsApproval('widget', 'publish', {})).toBe(false);
  await runtime.appCall('widget', 'publish', {});
  expect(called).toEqual(['publish']);
});

test('by default a tool marked for approval can be started as a background job', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const runtime = new Runtime(
    store,
    undefined,
    scripted([
      {
        type: 'tool',
        name: 'background',
        input: { action: 'start', tool: 'publish', input: { title: 'Launch' } },
        callId: 'b1',
      },
      say('Started.'),
      say('Published.'),
    ]),
  );
  withPublish(runtime, ran);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Publish it in the background');
  await runtime.run(c.id);
  await runtime.background.drain();
  expect(ran).toEqual([{ title: 'Launch' }]);
});

test('a chat saved waiting to propose an approval-marked call runs it after the upgrade', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const runtime = new Runtime(store, undefined, scripted([say('Posted.')]));
  withPublish(runtime, ran);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Publish it');
  await updateChat(store, c.id, (value) => ({
    ...value,
    status: 'running',
    pending: [],
    turn: {
      message: value.pending[0],
      call: {
        id: 'x',
        callId: 'p',
        name: 'publish',
        input: { title: 'Hi' },
        provider: 'social',
        state: 'proposed',
      },
    },
  }));
  await runtime.recover();
  await runtime.run(c.id);
  expect(ran).toEqual([{ title: 'Hi' }]);
  expect((await loadChat(store, c.id)).status).toBe('idle');
});

test('a worker killed while saving memory saves it again after the restart, with no review', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store, undefined, scripted([say('Noted.')]));
  const c = await runtime.create();
  await runtime.submit(c.id, 'Remember that I like coral');
  await updateChat(store, c.id, (value) => ({
    ...value,
    status: 'running',
    pending: [],
    turn: {
      message: value.pending[0],
      call: {
        id: 'x',
        callId: 'r',
        name: 'remember',
        input: { text: 'Likes coral.' },
        provider: 'local',
        state: 'started',
      },
    },
  }));
  await runtime.recover();
  await runtime.run(c.id);
  expect(await store.get('memory')).toBe('Likes coral.');
  const saved = await loadChat(store, c.id);
  expect(saved.status).toBe('idle');
  expect(saved.messages.at(-1)?.text).toBe('Noted.');
});
