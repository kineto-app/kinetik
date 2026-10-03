import { loadChat, updateChat } from './chat';
import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ConnectionError } from '../src/core/connection-error';
import { modelInput } from './model-input';
import type { Model } from '../src/core/types';

const read = async (store: Store, id: string) => (await loadChat(store, id))!;
/** Streams `words` then waits for `finish`; rejects when the signal aborts. */
function streaming(words: string[], finish: () => Promise<void>, fail?: Error): Model {
  return {
    next: (request, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
        let text = '';
        for (const word of words) request.onText?.((text += word));
        void finish().then(() => (fail ? reject(fail) : resolve({ type: 'text', text })));
      }),
  };
}

test('Stop keeps the answer written so far, marked, and out of the model input', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(
    store,
    undefined,
    streaming(['Lisbon ', 'has '], () => new Promise(() => {})),
  );
  const c = await runtime.create();
  await runtime.submit(c.id, 'Tell me about Lisbon');
  const turn = runtime.run(c.id);
  await expect.poll(async () => (await read(store, c.id)).status).toBe('running');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runtime.stop(c.id);
  await turn;
  const saved = await read(store, c.id);
  const kept = saved.messages.find((m) => m.aborted);
  expect(kept).toMatchObject({ role: 'assistant', text: 'Lisbon has ' });
  expect(JSON.stringify(await modelInput(store, c.id))).not.toContain('Lisbon has');
  expect(await store.get('partial:' + c.id)).toBeUndefined();
});

test('a worker killed mid-answer shows what was written, once, after the restart', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(
    store,
    undefined,
    streaming([], async () => {}),
  );
  const c = await runtime.create();
  await runtime.submit(c.id, 'Tell me about Lisbon');
  await updateChat(store, c.id, (value) => ({
    ...value!,
    status: 'running',
    pending: [],
    turn: { message: value!.pending[0], startedAt: Date.now() },
  }));
  await store.put('partial:' + c.id, 'Lisbon is a city of');
  await new Runtime(
    store,
    undefined,
    streaming(['Lisbon is lovely.'], async () => {}),
  ).recover();
  await new Runtime(store).recover();
  const saved = await read(store, c.id);
  expect(saved.messages.filter((m) => m.aborted).map((m) => m.text)).toEqual([
    'Lisbon is a city of',
  ]);
  expect(await store.get('partial:' + c.id)).toBeUndefined();
});

test('a lost connection drops the partial answer: the request is sent again', async () => {
  const store = new Store(crypto.randomUUID());
  let release!: () => void;
  const runtime = new Runtime(
    store,
    undefined,
    streaming(
      ['Half '],
      () => new Promise<void>((resolve) => (release = resolve)),
      new ConnectionError('offline'),
    ),
  );
  const c = await runtime.create();
  await runtime.submit(c.id, 'Tell me about Lisbon');
  const turn = runtime.run(c.id);
  await expect.poll(() => typeof release).toBe('function');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  release();
  await turn;
  const saved = await read(store, c.id);
  expect(saved.status).toBe('waiting');
  expect(saved.messages.some((m) => m.aborted)).toBe(false);
  expect(await store.get('partial:' + c.id)).toBeUndefined();
});

test('a change to one chat names that chat', async () => {
  const store = new Store(crypto.randomUUID());
  const events: unknown[] = [];
  const runtime = new Runtime(store, (event) => events.push(event));
  const c = await runtime.create();
  events.length = 0;
  await runtime.submit(c.id, 'Hello');
  expect(events).toContainEqual({ type: 'changed', conversationId: c.id });
});

test('a worker killed inside the helper continues it after the restart without repeating steps', async () => {
  const name = crypto.randomUUID();
  const helperCalls: number[] = [];
  const helperStep = (request: { instructions: string; history?: unknown[] }) =>
    request.instructions.startsWith('You are a helper') ? (request.history?.length ?? 0) : -1;
  const first = new Runtime(new Store(name), undefined, {
    next: async (request) => {
      const step = helperStep(request);
      if (step < 0)
        return { type: 'tool', name: 'delegate', input: { task: 'List files' }, callId: 'd' };
      helperCalls.push(step);
      if (step === 1)
        return { type: 'tool', name: 'list', input: { path: '/workspace' }, callId: 'l' };
      return new Promise(() => {});
    },
  });
  const c = await first.create();
  await first.submit(c.id, 'Research');
  void first.run(c.id);
  await expect.poll(() => helperCalls.length).toBe(2);
  const store = new Store(name);
  const second = new Runtime(store, undefined, {
    next: async (request) => {
      const step = helperStep(request);
      if (step < 0) return { type: 'text', text: 'Main: ' + request.result };
      helperCalls.push(step);
      return { type: 'text', text: 'Found the workspace.' };
    },
  });
  const locks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  try {
    await second.recover();
    await second.run(c.id);
  } finally {
    if (locks) Object.defineProperty(globalThis.navigator, 'locks', locks);
  }
  // Step 1 ran once; the restart resumed with its history instead of starting over.
  expect(helperCalls).toEqual([1, 3, 3]);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Main: Found the workspace.');
  expect(await store.keys('helper:')).toEqual([]);
});
