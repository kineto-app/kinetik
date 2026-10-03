import { loadChat, updateChat } from './chat';
import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ModelRouter } from '../src/models/router';
import { schemaVersion } from '../src/core/migrations';
import type {
  Conversation,
  Model,
  ModelRequest,
  ModelStep,
  ToolDefinition,
} from '../src/core/types';

const say = (text: string): ModelStep => ({ type: 'text', text });

test('a message queued during a turn uses the model chosen when it starts, not the last one', async () => {
  const store = new Store(crypto.randomUUID());
  const seen: string[] = [];
  const chatgpt: Model = {
    async next(request) {
      seen.push('chatgpt:' + request.message);
      // While the first answer streams, the user picks the custom model and queues a follow-up.
      await store.put('model-choice', 'custom');
      await routed.submit(c.id, 'Then summarise', undefined, [], 'after');
      return say('First answer');
    },
  };
  const custom: Model = {
    async next(request) {
      seen.push('custom:' + request.message);
      return say('Summary');
    },
  };
  const router = new ModelRouter(store, chatgpt, custom);
  const routed = new Runtime(store, undefined, router);
  const c = await routed.create();
  await routed.submit(c.id, 'Start');
  await routed.run(c.id);
  expect(seen).toEqual(['chatgpt:Start', 'custom:Then summarise']);
});

const read = async (store: Store, id: string) => (await loadChat(store, id))!;
function scripted(steps: ((request: ModelRequest) => ModelStep)[]): Model {
  return {
    async next(request) {
      const step = steps.shift();
      if (!step) throw new Error('Unexpected model call');
      return step(request);
    },
  };
}
/** Adds a plugin tool that records each run. */
function withTool(runtime: Runtime, ran: unknown[], tool: Partial<ToolDefinition> = {}) {
  const snapshot = runtime.plugins.snapshot.bind(runtime.plugins);
  runtime.plugins.snapshot = async (builtins, records) => {
    const result = await snapshot(builtins, records);
    result.bindings.post = {
      provider: 'demo',
      tool: {
        description: 'Post',
        inputSchema: { type: 'object' },
        execute: async (input) => {
          ran.push(input);
          return 'Posted';
        },
        ...tool,
      },
    };
    return result;
  };
}
/** A killed worker leaves its locks behind; the next one runs without them. */
async function asNewWorker<T>(work: () => Promise<T>): Promise<T> {
  const locks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  try {
    return await work();
  } finally {
    if (locks) Object.defineProperty(globalThis.navigator, 'locks', locks);
    else delete (globalThis.navigator as { locks?: unknown }).locks;
  }
}
const post = (): ModelStep => ({ type: 'tool', name: 'post', input: { text: 'Hi' }, callId: 'p' });

test('a worker killed after recording a call but before starting it runs it once on restart', async () => {
  const name = crypto.randomUUID();
  const store = new Store(name);
  const ran: unknown[] = [];
  const first = new Runtime(store, undefined, scripted([post]));
  withTool(first, ran);
  // The worker dies on the write that would mark the call started.
  const update = store.updateMany.bind(store);
  store.updateMany = async (keys, change) => {
    let starting = false;
    try {
      return await update(keys, (values) => {
        const writes = change(values);
        starting = writes.some(
          ([, value]) => (value as Conversation | undefined)?.turn?.call?.state === 'started',
        );
        if (starting) throw new Error('killed');
        return writes;
      });
    } catch (error) {
      if (starting) return new Promise<void>(() => {});
      throw error;
    }
  };
  const c = await first.create();
  await first.submit(c.id, 'Post it');
  void first.run(c.id);
  await expect.poll(async () => (await read(store, c.id)).turn?.call?.state).toBe('proposed');
  const fresh = new Store(name);
  const second = new Runtime(fresh, undefined, scripted([() => say('Done')]));
  withTool(second, ran);
  await asNewWorker(async () => {
    await second.recover();
    await second.run(c.id);
  });
  expect(ran).toEqual([{ text: 'Hi' }]);
  expect((await read(fresh, c.id)).status).toBe('idle');
});

test('a recorded call that needs approval still asks when recovery resumes it', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const runtime = new Runtime(store, undefined, scripted([]));
  withTool(runtime, ran, { approval: true });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Post it');
  await updateChat(store, c.id, (value) => ({
    ...value!,
    status: 'running',
    pending: [],
    turn: {
      message: value!.pending[0],
      call: {
        id: 'x',
        callId: 'p',
        name: 'post',
        input: { text: 'Hi' },
        provider: 'demo',
        state: 'proposed',
      },
    },
  }));
  await runtime.recover();
  await runtime.run(c.id);
  expect(ran).toEqual([]);
  const saved = await read(store, c.id);
  expect(saved.status).toBe('asking');
  expect(saved.turn?.call?.state).toBe('awaiting');
});

test('a worker killed while a call runs leaves it for review, never runs it again', async () => {
  const name = crypto.randomUUID();
  const store = new Store(name);
  const ran: unknown[] = [];
  const first = new Runtime(store, undefined, scripted([post]));
  withTool(first, ran, {
    execute: async (input) => {
      ran.push(input);
      return new Promise(() => {});
    },
  });
  const c = await first.create();
  await first.submit(c.id, 'Post it');
  void first.run(c.id);
  await expect.poll(() => ran.length).toBe(1);
  const second = new Runtime(new Store(name), undefined, scripted([]));
  withTool(second, ran);
  await asNewWorker(async () => {
    await second.recover();
    await second.run(c.id);
  });
  expect(ran).toHaveLength(1);
  const saved = await read(store, c.id);
  expect(saved.status).toBe('needs_review');
  expect(saved.turn?.call?.state).toBe('unknown');
});

test.each([
  [{ state: 'pending', approved: true }, 'approved'],
  [{ state: 'pending' }, 'started'],
  [{ state: 'awaiting' }, 'awaiting'],
  [{ state: 'completed', result: 'ok' }, 'completed'],
  [{ state: 'unknown' }, 'unknown'],
])('migration 5 maps an old call %o to %s', async (old, state) => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await store.put('meta:schema', 4);
  await store.put('conversation:' + c.id, {
    ...(await read(store, c.id)),
    status: 'idle',
    turn: 'foreground',
    activeMessage: 'm1',
    workStartedAt: 123,
    turnModel: { provider: 'custom' },
    turnUsage: { input: 5, output: 2 },
    call: { id: 'x', name: 'post', input: {}, provider: 'demo', ...old },
  });
  await runtime.recover();
  const saved = (await read(store, c.id)) as Conversation & Record<string, unknown>;
  expect(saved.turn).toMatchObject({
    kind: 'foreground',
    message: 'm1',
    startedAt: 123,
    model: { provider: 'custom' },
    usage: { input: 5, output: 2 },
  });
  expect(saved.turn?.call?.state).toBe(state);
  expect(saved.turn?.call).not.toHaveProperty('approved');
  for (const field of ['activeMessage', 'workStartedAt', 'turnModel', 'turnUsage', 'call'])
    expect(saved).not.toHaveProperty(field);
  expect(await store.get('meta:schema')).toBe(schemaVersion);
});

test('migration 5 leaves a chat with no turn without one, and running it again changes nothing', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const idle = await runtime.create();
  await runtime.recover();
  const before = await read(store, idle.id);
  expect(before.turn).toBeUndefined();
  await store.put('meta:schema', 4);
  await new Runtime(store).recover();
  expect(await read(store, idle.id)).toEqual(before);
});

test('an old call that may have started goes to review after the upgrade, never runs again', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const runtime = new Runtime(store, undefined, scripted([]));
  withTool(runtime, ran);
  const c = await runtime.create();
  await store.put('meta:schema', 4);
  await store.put('conversation:' + c.id, {
    ...(await read(store, c.id)),
    status: 'running',
    activeMessage: 'm1',
    call: { id: 'x', name: 'post', input: {}, provider: 'demo', state: 'pending' },
  });
  await runtime.recover();
  await runtime.run(c.id);
  expect(ran).toEqual([]);
  expect((await read(store, c.id)).status).toBe('needs_review');
});

test.each(['proposed', 'approved', 'started'] as const)(
  'a new message after a stopped remote call in state %s still answers that call',
  async (state) => {
    const store = new Store(crypto.randomUUID());
    const seen: ModelRequest[] = [];
    const runtime = new Runtime(store, undefined, {
      async next(request) {
        seen.push(request);
        return say('Fine');
      },
    });
    const c = await runtime.create();
    await updateChat(store, c.id, (value) => ({
      ...value!,
      status: 'stopped',
      modelInput: [
        { role: 'user', content: 'Post it' },
        { type: 'function_call', call_id: 'p', name: 'post', arguments: '{}' },
      ],
      turn: {
        message: 'm1',
        call: { id: 'x', callId: 'p', name: 'post', input: {}, provider: 'demo', state },
      },
    }));
    await runtime.submit(c.id, 'Never mind');
    await runtime.run(c.id);
    const outputs = seen[0].history!.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.call_id)).toEqual(['p']);
  },
);
