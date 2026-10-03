import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ContextOverflow } from '../src/core/connection-error';
import { compactPrompt, summaryPrefix } from '../src/core/compaction';
import { readResponse } from '../src/core/openai-model';
import type { Conversation, Model, ModelRequest, ModelStep } from '../src/core/types';

const read = async (store: Store, id: string) =>
  (await store.get<Conversation>('conversation:' + id))!;
const sse = (...events: unknown[]) =>
  new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));

/** A scripted model: each call returns the next step and records the request it saw. */
function scripted(steps: ((request: ModelRequest) => ModelStep | Promise<ModelStep>)[]) {
  const seen: ModelRequest[] = [];
  const model: Model = {
    async next(request) {
      seen.push(request);
      if (request.message === compactPrompt)
        return { type: 'text', text: 'Notes: the user likes short answers.' };
      const step = steps.shift();
      if (!step) throw new Error('Unexpected model call');
      return step(request);
    },
  };
  return { model, seen };
}
const reply = (text: string, input = 1000): ModelStep => ({
  type: 'text',
  text,
  items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  usage: { input, output: 10 },
  contextWindow: 10000,
});

test('usage is read from the completed stream and context errors are recognised', async () => {
  const meta: { usage?: { input: number; output: number } } = {};
  await readResponse(
    sse({
      type: 'response.completed',
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: {
          input_tokens: 1200,
          output_tokens: 34,
          input_tokens_details: { cached_tokens: 800 },
        },
      },
    }),
    undefined,
    meta,
  );
  expect(meta.usage).toEqual({ input: 1200, output: 34, cached: 800 });
  await expect(
    readResponse(
      sse({
        type: 'response.failed',
        response: { error: { code: 'context_length_exceeded', message: 'Too long' } },
      }),
    ),
  ).rejects.toBeInstanceOf(ContextOverflow);
  await expect(
    readResponse(
      Response.json({ error: { code: 'context_length_exceeded', message: 'x' } }, { status: 400 }),
    ),
  ).rejects.toBeInstanceOf(ContextOverflow);
});

test('a turn records its token usage and the context fill', async () => {
  const store = new Store(crypto.randomUUID());
  const { model } = scripted([() => reply('Hello', 1500)]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hi');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.messages.at(-1)?.usage).toEqual({ input: 1500, output: 10 });
  expect(saved.context).toEqual({ tokens: 1510, window: 10000 });
});

test('a full context is summarised before the next request, keeping the latest request verbatim', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () => reply('First answer', 8000),
    (request) => {
      expect(request.history?.[0]).toEqual({
        role: 'user',
        content: summaryPrefix + 'Notes: the user likes short answers.',
      });
      expect(request.history?.at(-1)).toMatchObject({ role: 'user', content: 'Second question' });
      return reply('Second answer', 900);
    },
  ]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'First question');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Second question');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(seen.filter((request) => request.message === compactPrompt)).toHaveLength(1);
  expect(saved.compactions).toBe(1);
  expect(saved.messages.some((m) => m.compaction)).toBe(true);
  expect(saved.messages.at(-1)?.text).toBe('Second answer');
  const archived = await store.get<Record<string, unknown>[]>(`model-archive:${c.id}:1`);
  expect(archived?.[0]).toMatchObject({ role: 'user', content: 'First question' });
});

test('a failed summary leaves the conversation intact and the next run still works', async () => {
  const store = new Store(crypto.randomUUID());
  let failSummary = true;
  const model: Model = {
    async next(request) {
      if (request.message === compactPrompt) {
        if (failSummary) throw new Error('worker killed');
        return { type: 'text', text: 'Notes.' };
      }
      return reply('Answer ' + request.message, 8000);
    },
  };
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'One');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Two');
  await runtime.run(c.id);
  const failed = await read(store, c.id);
  expect(failed.compactions).toBeUndefined();
  expect(failed.modelInput?.[0]).toMatchObject({ role: 'user', content: 'One' });
  failSummary = false;
  await runtime.submit(c.id, 'Three');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.compactions).toBe(1);
  expect(saved.messages.at(-1)?.text).toBe('Answer Three');
});

test('an overflow summarises once and retries; a second overflow stops with a clear message', async () => {
  const store = new Store(crypto.randomUUID());
  let overflows = 1;
  const model: Model = {
    async next(request) {
      if (request.message === compactPrompt) return { type: 'text', text: 'Notes.' };
      if (request.message === 'Big' && overflows-- > 0)
        throw new ContextOverflow('context_length_exceeded');
      if (request.message === 'Huge') throw new ContextOverflow('context_length_exceeded');
      return reply('Done ' + request.message);
    },
  };
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Small');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Big');
  await runtime.run(c.id);
  let saved = await read(store, c.id);
  expect(saved.messages.at(-1)?.text).toBe('Done Big');
  expect(saved.compactions).toBe(1);
  await runtime.submit(c.id, 'Huge');
  await runtime.run(c.id);
  saved = await read(store, c.id);
  expect(saved.status).toBe('stopped');
  expect(saved.messages.at(-1)?.text).toContain('Start a new chat');
});

test('invalid arguments and unknown tools go back to the model, which corrects itself', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () => ({ type: 'tool', name: 'write', input: { path: 5 } }),
    () => ({ type: 'tool', name: 'no_such_tool', input: {} }),
    () => ({ type: 'tool', name: 'write', input: { path: '/workspace/a.txt', content: 'ok' } }),
    () => reply('Saved it.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Save a file');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(seen[1].result).toMatch(/^Error: Invalid tool arguments/);
  expect(seen[2].result).toBe('Error: There is no tool named no_such_tool.');
  expect(saved.status).toBe('idle');
  expect(saved.messages.at(-1)?.text).toBe('Saved it.');
  expect(saved.messages.filter((m) => m.activity?.outcome === 'failed')).toHaveLength(2);
});

test('a missing-file read is returned to the model, but a failing edit still needs review', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () => ({ type: 'tool', name: 'read', input: { path: '/workspace/missing.txt' } }),
    () => reply('That file does not exist.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Read it');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(seen[1].result).toMatch(/^Error: /);
  expect(saved.status).toBe('idle');

  const failing = new Store(crypto.randomUUID());
  const writer = new Runtime(
    failing,
    undefined,
    scripted([
      () => ({
        type: 'tool',
        name: 'edit',
        input: { path: '/workspace/none.txt', oldText: 'a', newText: 'b' },
      }),
    ]).model,
  );
  const d = await writer.create();
  await writer.submit(d.id, 'Edit a missing file');
  await writer.run(d.id);
  expect((await read(failing, d.id)).status).toBe('needs_review');
});

test('the same action repeated with the same input stops the turn', async () => {
  const store = new Store(crypto.randomUUID());
  const step = (): ModelStep => ({ type: 'tool', name: 'list', input: { path: '/workspace' } });
  const runtime = new Runtime(store, undefined, scripted([step, step, step, step]).model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Loop');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.status).toBe('stopped');
  expect(saved.messages.at(-1)?.text).toMatch(/same action \(list\) was requested 4 times/);
});

test('/compact summarises on demand and says when there is nothing to summarise', async () => {
  const store = new Store(crypto.randomUUID());
  const { model } = scripted([() => reply('A'), () => reply('B')]);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, '/compact');
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Nothing to summarise yet.');
  await runtime.submit(c.id, 'One');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Two');
  await runtime.run(c.id);
  await runtime.submit(c.id, '/compact');
  const saved = await read(store, c.id);
  expect(saved.compactions).toBe(1);
  expect(saved.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
    'One',
    'Two',
  ]);
});
