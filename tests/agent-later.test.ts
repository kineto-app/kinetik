import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { modelInput } from './model-input';
import type { Conversation, Model, ModelRequest, ModelStep } from '../src/core/types';

const read = async (store: Store, id: string) =>
  (await store.get<Conversation>('conversation:' + id))!;
function scripted(steps: ((request: ModelRequest) => ModelStep)[]) {
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
const batch = (...calls: [string, Record<string, unknown>][]): ModelStep => ({
  type: 'tools',
  calls: calls.map(([name, input], i) => ({ name, input, callId: 'b' + i })),
  items: calls.map(([name, input], i) => ({
    type: 'function_call',
    call_id: 'b' + i,
    name,
    arguments: JSON.stringify(input),
  })),
});
/** Delays Kinetik's read-only tools so overlap is measurable. */
function slowReads(runtime: Runtime, ms: number, hang = false) {
  const snapshot = runtime.plugins.snapshot.bind(runtime.plugins);
  runtime.plugins.snapshot = async (builtins, records) => {
    const result = await snapshot(builtins, records);
    for (const name of ['read', 'list']) {
      const binding = result.bindings[name];
      const execute = binding.tool.execute;
      result.bindings[name] = {
        ...binding,
        tool: {
          ...binding.tool,
          execute: async (input, context) => {
            await new Promise((resolve) => setTimeout(resolve, ms));
            if (hang) await new Promise(() => {});
            return execute(input, context);
          },
        },
      };
    }
    return result;
  };
}

test('several read-only calls run at once and all their outputs reach the model', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () =>
      batch(
        ['list', { path: '/workspace' }],
        ['list', { path: '/' }],
        ['read', { path: '/workspace/none.md' }],
      ),
    () => say('Compared.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  slowReads(runtime, 150);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Compare');
  const started = Date.now();
  await runtime.run(c.id);
  expect(Date.now() - started).toBeLessThan(400);
  const outputs = (await modelInput(store, c.id))!.filter((i) => i.type === 'function_call_output');
  expect(outputs.map((o) => o.call_id)).toEqual(['b0', 'b1', 'b2']);
  expect(String(outputs[2].output)).toMatch(/^Error: /);
  expect(seen[1].result).toContain('read: Error: ');
  const saved = await read(store, c.id);
  expect(saved.status).toBe('idle');
  expect(saved.messages.filter((m) => m.role === 'tool')).toHaveLength(3);
});

test('a batch with a tool that may change something runs nothing', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () =>
      batch(['write', { path: '/workspace/a.md', content: 'A' }], ['list', { path: '/workspace' }]),
    () => ({
      type: 'tool',
      name: 'write',
      input: { path: '/workspace/a.md', content: 'A' },
      callId: 'w',
    }),
    () => say('Saved.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Save');
  await runtime.run(c.id);
  expect(seen[1].result).toContain('may run in parallel. Nothing ran');
  const saved = await read(store, c.id);
  expect(saved.messages.filter((m) => m.activity?.returned)).toHaveLength(2);
  expect(saved.messages.at(-1)?.text).toBe('Saved.');
  // The file was written once, by the single call.
  const files = await store.get<{ entries: { path: string }[] }>('filesystem');
  expect(files?.entries.filter((e) => e.path === '/workspace/a.md')).toHaveLength(1);
});

test('a worker killed during a batch leaves no unanswered call and simply asks again', async () => {
  const store = new Store(crypto.randomUUID());
  const first = new Runtime(
    store,
    undefined,
    scripted([() => batch(['list', { path: '/' }], ['list', { path: '/workspace' }])]).model,
  );
  slowReads(first, 10, true);
  const c = await first.create();
  await first.submit(c.id, 'Look');
  void first.run(c.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await read(store, c.id)).status).toBe('running');
  // Nothing of the batch is saved while it runs.
  expect((await modelInput(store, c.id))!.some((i) => i.type === 'function_call')).toBe(false);
  // A new worker takes over the same storage. A killed worker's locks are gone; the hung one
  // here still holds them, so the new worker runs without locks.
  const locks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  const { model, seen } = scripted([() => say('Looked.')]);
  const second = new Runtime(store, undefined, model);
  try {
    await second.recover();
    await second.run(c.id);
  } finally {
    if (locks) Object.defineProperty(globalThis.navigator, 'locks', locks);
    else delete (globalThis.navigator as { locks?: unknown }).locks;
  }
  expect(seen).toHaveLength(1);
  expect((await modelInput(store, c.id))!.some((i) => i.type === 'function_call')).toBe(false);
  const saved = await read(store, c.id);
  expect(saved.status).toBe('idle');
  expect(saved.messages.at(-1)?.text).toBe('Looked.');
});

test('a helper agent reads with its own history and returns its findings', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () => ({
      type: 'tool',
      name: 'delegate',
      input: { task: 'List the workspace and report.' },
      callId: 'd1',
    }),
    // The helper: tries to write, is refused, lists, then reports.
    () => ({
      type: 'tool',
      name: 'write',
      input: { path: '/workspace/x', content: 'x' },
      callId: 'h1',
      usage: { input: 100, output: 5 },
    }),
    () => ({
      type: 'tool',
      name: 'list',
      input: { path: '/workspace' },
      callId: 'h2',
      usage: { input: 120, output: 5 },
    }),
    () => ({ type: 'text', text: 'The workspace is empty.', usage: { input: 140, output: 8 } }),
    (request) => say('Helper said: ' + request.result),
  ]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Check my files with a helper');
  await runtime.run(c.id);
  const helper = seen[1];
  expect(helper.history).toEqual([{ role: 'user', content: 'List the workspace and report.' }]);
  expect(Object.keys(helper.definitions ?? {}).sort()).toEqual(['list', 'read', 'read_skill']);
  expect(seen[2].result).toBe('Error: There is no read-only tool named write.');
  const saved = await read(store, c.id);
  expect(saved.messages.at(-1)?.text).toBe('Helper said: The workspace is empty.');
  expect(saved.messages.at(-1)?.usage).toMatchObject({ input: 360, output: 18 });
  const files = await store.get<{ entries: { path: string }[] }>('filesystem');
  expect(files?.entries.some((e) => e.path === '/workspace/x') ?? false).toBe(false);
});

test('a helper or a read interrupted by a restart runs again instead of going to review', async () => {
  const store = new Store(crypto.randomUUID());
  const first = new Runtime(
    store,
    undefined,
    scripted([
      () => ({ type: 'tool', name: 'delegate', input: { task: 'Look' }, callId: 'd1' }),
      () => new Promise<ModelStep>(() => {}) as never,
    ]).model,
  );
  const c = await first.create();
  await first.submit(c.id, 'Look with a helper');
  void first.run(c.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await read(store, c.id)).call).toMatchObject({ name: 'delegate', state: 'pending' });
  const locks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  const { model, seen } = scripted([
    () => say('Nothing there.'),
    (request) => say('Helper: ' + request.result),
  ]);
  const second = new Runtime(store, undefined, model);
  try {
    await second.recover();
    expect((await read(store, c.id)).status).toBe('queued');
    await second.run(c.id);
  } finally {
    if (locks) Object.defineProperty(globalThis.navigator, 'locks', locks);
    else delete (globalThis.navigator as { locks?: unknown }).locks;
  }
  // The helper ran again from its task; the main model was not asked to repeat the call.
  expect(seen[0].history).toEqual([{ role: 'user', content: 'Look' }]);
  const saved = await read(store, c.id);
  expect(saved.status).toBe('idle');
  expect(saved.messages.at(-1)?.text).toBe('Helper: Nothing there.');
});

/** A model whose text replies report a nearly full context, with optional provider compaction. */
function fullModel(compact?: Model['compact'], fail?: () => boolean) {
  const seen: ModelRequest[] = [];
  const model: Model = {
    compact,
    async next(request) {
      seen.push(request);
      if (request.message.startsWith('Summarise the conversation')) return say('Local notes.');
      if (fail?.()) throw new Error('Model request failed: HTTP 400');
      return {
        type: 'text',
        text: 'Answer to ' + request.message,
        items: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
        ],
        usage: { input: 9000, output: 10 },
        contextWindow: 10000,
      };
    },
  };
  return { model, seen };
}

test('ChatGPT compaction replaces older input with its opaque items when available', async () => {
  const store = new Store(crypto.randomUUID());
  const compacted = [{ type: 'compaction', encrypted_content: 'opaque' }];
  const calls: unknown[][] = [];
  const { model, seen } = fullModel(async (input) => {
    calls.push(input);
    return compacted;
  });
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'One');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Two');
  await runtime.run(c.id);
  expect(calls[0]).toEqual([
    { role: 'user', content: 'One' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
  ]);
  expect(seen.some((r) => r.message.startsWith('Summarise'))).toBe(false);
  expect(seen.at(-1)?.history?.[0]).toEqual(compacted[0]);
  const saved = await read(store, c.id);
  expect(saved.serverCompaction).toBeUndefined();
  expect(saved.messages.find((m) => m.compaction)?.text).toContain('Only ChatGPT can read');
});

test('a failed provider compaction falls back to the local summary', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = fullModel(async () => {
    throw new Error('Compaction failed: HTTP 404');
  });
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'One');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Two');
  await runtime.run(c.id);
  expect(seen.some((r) => r.message.startsWith('Summarise'))).toBe(true);
  expect((await modelInput(store, c.id))?.[0]).toMatchObject({
    content: expect.stringContaining('Local notes.'),
  });
});

test('a request rejected right after provider compaction restores the input and stops using it', async () => {
  const store = new Store(crypto.randomUUID());
  let rejectOnce = false;
  const { model } = fullModel(
    async () => {
      rejectOnce = true;
      return [{ type: 'compaction', encrypted_content: 'opaque' }];
    },
    () => {
      if (!rejectOnce) return false;
      rejectOnce = false;
      return true;
    },
  );
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'One');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Two');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.messages.at(-1)?.text).toBe('Answer to Two');
  const input = (await modelInput(store, c.id))!;
  expect(input.some((i) => i.type === 'compaction')).toBe(false);
  expect(input[0]).toEqual({ role: 'user', content: 'One' });
  expect(await store.get('no-server-compact:chatgpt')).toBe(true);
});

/** Runs `work` as a new worker would after the old one was killed: the dead one's locks are gone. */
async function asNewWorker(work: () => Promise<void>) {
  const locks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  try {
    await work();
  } finally {
    if (locks) Object.defineProperty(globalThis.navigator, 'locks', locks);
    else delete (globalThis.navigator as { locks?: unknown }).locks;
  }
}

test('a turn killed mid-tool finishes on the model it started with, even after a switch', async () => {
  const store = new Store(crypto.randomUUID());
  await store.put('model-choice', 'custom');
  const router = (claude: Model, chatgpt: Model) => {
    const model: Model = {
      pin: () => store.get<string>('model-choice'),
      next: (request, signal) =>
        request.pin === 'custom' ? claude.next(request, signal) : chatgpt.next(request, signal),
    };
    return model;
  };
  const never: Model = { next: () => new Promise(() => {}) };
  const first = new Runtime(
    store,
    undefined,
    router(
      scripted([() => ({ type: 'tool', name: 'list', input: { path: '/' }, callId: 'l' })]).model,
      never,
    ),
  );
  slowReads(first, 10, true);
  const c = await first.create();
  await first.submit(c.id, 'Look');
  void first.run(c.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The user switches to ChatGPT while the custom-model turn is cut off.
  await store.delete('model-choice');
  const claude = scripted([() => say('Custom model finished.')]);
  const chatgpt = scripted([]);
  await asNewWorker(async () => {
    const second = new Runtime(store, undefined, router(claude.model, chatgpt.model));
    await second.recover();
    await second.run(c.id);
  });
  expect(claude.seen).toHaveLength(1);
  expect(chatgpt.seen).toHaveLength(0);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Custom model finished.');
});

test('a worker killed right after a provider compaction still undoes it when the next request fails', async () => {
  const store = new Store(crypto.randomUUID());
  let calls = 0;
  const first: Model = {
    compact: async () => [{ type: 'compaction', encrypted_content: 'opaque' }],
    async next(request) {
      calls++;
      // Turn 1 fills the context; the request after the compaction never returns.
      if (calls === 2) return new Promise<ModelStep>(() => {});
      return {
        type: 'text',
        text: 'Answer to ' + request.message,
        items: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
        ],
        usage: { input: 9000, output: 10 },
        contextWindow: 10000,
      };
    },
  };
  const a = new Runtime(store, undefined, first);
  const c = await a.create();
  await a.submit(c.id, 'One');
  await a.run(c.id);
  await a.submit(c.id, 'Two');
  void a.run(c.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await read(store, c.id)).serverCompaction).toBeTruthy();
  let rejected = false;
  const second: Model = {
    async next(request) {
      if (!rejected) {
        rejected = true;
        throw new Error('Model request failed: HTTP 400');
      }
      return { type: 'text', text: 'Recovered: ' + request.message };
    },
  };
  await asNewWorker(async () => {
    const b = new Runtime(store, undefined, second);
    await b.recover();
    await b.run(c.id);
  });
  const saved = await read(store, c.id);
  expect(saved.messages.at(-1)?.text).toBe('Recovered: Two');
  expect((await modelInput(store, c.id))![0]).toEqual({ role: 'user', content: 'One' });
});
