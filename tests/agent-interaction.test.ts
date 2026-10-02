import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import type {
  Conversation,
  Model,
  ModelRequest,
  ModelStep,
  ToolDefinition,
} from '../src/core/types';

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

test('photo previews reach the model as image parts next to the text', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([() => say('I see a photo.')]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  const photo = await runtime.stageAttachment(
    c.id,
    'beach.jpg',
    new Uint8Array([1, 2]),
    new Uint8Array([255, 216, 255, 0]),
  );
  await runtime.submit(c.id, 'Use this', undefined, [photo.id]);
  await runtime.run(c.id);
  const content = seen[0].history!.at(-1)!.content as {
    type: string;
    text?: string;
    image_url?: string;
  }[];
  expect(content[0]).toMatchObject({ type: 'input_text' });
  expect(content[0].text).toContain('Use this');
  expect(content[1]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AA==' });
});

test('a queued follow-up waits for the turn to end; steering joins at the next boundary', async () => {
  const store = new Store(crypto.randomUUID());
  let runtime!: Runtime;
  let id = '';
  const { model, seen } = scripted([
    () => ({ type: 'tool', name: 'list', input: { path: '/workspace' } }),
    () => say('First done.'),
    () => say('Follow-up done.'),
  ]);
  const original = model.next.bind(model);
  model.next = async (request, signal) => {
    // While the first request is running, the user queues one message and steers with nothing.
    if (seen.length === 0)
      await runtime.submit(id, 'After that, summarise', undefined, [], 'after');
    return original(request, signal);
  };
  runtime = new Runtime(store, undefined, model);
  id = (await runtime.create()).id;
  await runtime.submit(id, 'Look at files');
  await runtime.run(id);
  const saved = await read(store, id);
  expect(saved.messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
    'First done.',
    'Follow-up done.',
  ]);
  // The follow-up was not part of the first turn's tool step.
  expect(seen[1].history?.some((item) => String(item.content).includes('summarise'))).toBe(false);
  expect(saved.messages.find((m) => m.text === 'After that, summarise')?.queue).toBeUndefined();
});

test('the ask tool pauses for a choice and the answer resumes the turn', async () => {
  const store = new Store(crypto.randomUUID());
  const alerts: string[] = [];
  const { model, seen } = scripted([
    () => ({
      type: 'tool',
      name: 'ask',
      input: { question: 'Which style?', options: ['Bold', 'Calm'] },
      callId: 'c1',
    }),
    (request) => say('Going with ' + request.result),
  ]);
  const runtime = new Runtime(store, undefined, model);
  runtime.notify = async ({ body }) => void alerts.push(body);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Make a carousel');
  await runtime.run(c.id);
  let saved = await read(store, c.id);
  expect(saved.status).toBe('asking');
  expect(saved.call?.ask).toEqual({
    kind: 'choice',
    question: 'Which style?',
    options: ['Bold', 'Calm'],
  });
  expect(alerts).toEqual(['Which style?']);
  // A restart while waiting does not treat the pause as an uncertain effect.
  const reopened = new Runtime(store, undefined, model);
  await reopened.recover();
  expect((await read(store, c.id)).status).toBe('asking');
  await reopened.answer(c.id, 'Calm');
  await reopened.run(c.id);
  saved = await read(store, c.id);
  expect(seen[1].result).toBe('The user chose: Calm');
  expect(saved.modelInput).toContainEqual({
    type: 'function_call_output',
    call_id: 'c1',
    output: 'The user chose: Calm',
  });
  expect(saved.messages.at(-1)?.text).toBe('Going with The user chose: Calm');
});

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

test('an action marked for approval runs only after the user approves it', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const { model } = scripted([
    () => ({ type: 'tool', name: 'publish', input: { title: 'Launch' }, callId: 'p1' }),
    (request) => say('Result: ' + request.result),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withPublish(runtime, ran);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Publish it');
  await runtime.run(c.id);
  expect((await read(store, c.id)).call?.ask?.kind).toBe('approval');
  expect(ran).toEqual([]);
  await runtime.answer(c.id, 'approve');
  await runtime.run(c.id);
  expect(ran).toEqual([{ title: 'Launch' }]);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Result: Published');
});

test('a declined action never runs and the model is told', async () => {
  const store = new Store(crypto.randomUUID());
  const ran: unknown[] = [];
  const { model, seen } = scripted([
    () => ({ type: 'tool', name: 'publish', input: { title: 'Launch' }, callId: 'p1' }),
    () => say('Okay, not publishing.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withPublish(runtime, ran);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Publish it');
  await runtime.run(c.id);
  await runtime.answer(c.id, 'decline');
  await runtime.run(c.id);
  expect(ran).toEqual([]);
  expect(seen[1].result).toBe('The user declined this action. Do not run it.');
  expect((await read(store, c.id)).status).toBe('idle');
});

test('a new message instead of an answer closes the question for the model', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () => ({
      type: 'tool',
      name: 'ask',
      input: { question: 'Which?', options: ['A', 'B'] },
      callId: 'q1',
    }),
    () => say('Understood.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Start');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Actually, never mind');
  await runtime.run(c.id);
  expect(seen[1].history).toContainEqual({
    type: 'function_call_output',
    call_id: 'q1',
    output: 'The user did not answer and sent a new message instead.',
  });
  expect((await read(store, c.id)).status).toBe('idle');
});

test('memory proposals are saved only when confirmed, and every chat reads the memory', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () => ({
      type: 'tool',
      name: 'remember',
      input: { text: 'Writes in Russian. Brand: coral.' },
      callId: 'm1',
    }),
    () => say('Saved.'),
    () => say('Hello again.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Remember my style');
  await runtime.run(c.id);
  expect((await read(store, c.id)).call?.ask).toMatchObject({
    kind: 'memory',
    text: 'Writes in Russian. Brand: coral.',
  });
  expect(await store.get('memory')).toBeUndefined();
  await runtime.answer(c.id, 'save');
  await runtime.run(c.id);
  expect(await store.get('memory')).toBe('Writes in Russian. Brand: coral.');
  const d = await runtime.create();
  await runtime.submit(d.id, 'Hi');
  await runtime.run(d.id);
  expect(seen[2].instructions).toMatch(/^About the user .*\nWrites in Russian\. Brand: coral\./);
});

test('a finished reply is announced through the notifier', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(
    store,
    undefined,
    scripted([() => say('Your **carousel** is ready.')]).model,
  );
  const alerts: { title: string; body: string }[] = [];
  runtime.notify = async (alert) => void alerts.push(alert);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Build it');
  await runtime.run(c.id);
  expect(alerts).toEqual([
    { conversationId: c.id, title: 'Build it', body: 'Your carousel is ready.' },
  ]);
});
