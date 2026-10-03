import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import {
  ConnectionError,
  ContextOverflow,
  ModelRejected,
  SignInRequired,
} from '../src/core/connection-error';
import { OpenAIModel, readResponse } from '../src/models/openai';
import { CompatModel } from '../src/models/compat';
import { modelInput } from './model-input';
import type { Conversation, Model, ModelRequest } from '../src/core/types';

const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
const request: ModelRequest = {
  message: 'Hi',
  instructions: '',
  tools: ['read'],
  definitions: { read: { description: 'Read', inputSchema: { type: 'object' } } },
};
const signal = () => new AbortController().signal;

test.each([
  [400, { error: { message: 'Unsupported parameter' } }, ModelRejected],
  [400, { error: { message: 'Too long', code: 'context_length_exceeded' } }, ContextOverflow],
  [401, {}, SignInRequired],
  [429, {}, ConnectionError],
])('HTTP %i means %o to the turn', async (status, body, kind) => {
  await expect(readResponse(Response.json(body, { status }))).rejects.toBeInstanceOf(kind);
  const compat = new CompatModel(
    async () => ({ baseUrl: 'https://compat.test/v1', model: 'm', apiKey: 'k' }) as never,
    async () => Response.json(body, { status }),
  );
  await expect(compat.next(request, signal())).rejects.toBeInstanceOf(kind);
});

test('a provider failure inside the stream is a rejection; a busy provider is a wait', async () => {
  await expect(
    readResponse(sse({ type: 'response.failed', response: { error: { message: 'Bad input' } } })),
  ).rejects.toBeInstanceOf(ModelRejected);
  for (const [code, kind] of [
    ['server_error', ConnectionError],
    ['rate_limit_exceeded', ConnectionError],
    ['insufficient_quota', ModelRejected],
  ] as const)
    await expect(
      readResponse(sse({ type: 'error', error: { message: 'No', code } })),
    ).rejects.toBeInstanceOf(kind);
  const filtered = readResponse(
    sse({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'content_filter' } },
    }),
  );
  await expect(filtered).rejects.toThrow('content_filter');
  await expect(filtered).rejects.not.toBeInstanceOf(ModelRejected);
});

test('a network failure reaching ChatGPT is a connection error', async () => {
  const model = new OpenAIModel(
    async () => ({ account: 'a', model: 'm' }),
    async () => {
      throw new TypeError('Load failed');
    },
  );
  await expect(model.next(request, signal())).rejects.toBeInstanceOf(ConnectionError);
});

test('both adapters read tool calls the same way', async () => {
  const openai = (args: string) =>
    new OpenAIModel(
      async () => ({ account: 'a', model: 'm' }),
      async (body) => {
        const name = (body.request.tools as { tools: { name: string }[] }[])[0].tools[0].name;
        return sse({
          type: 'response.completed',
          response: {
            output: [{ type: 'function_call', name, call_id: 'c1', arguments: args }],
          },
        });
      },
    );
  const compat = (args: string) =>
    new CompatModel(
      async () => ({ baseUrl: 'https://compat.test/v1', model: 'm' }) as never,
      async (_url, init) => {
        const name = JSON.parse(String(init?.body)).tools[0].function.name;
        return sse(
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: args } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        );
      },
    );
  for (const make of [openai, compat]) {
    await expect(make('{"path":"a"}').next(request, signal())).resolves.toMatchObject({
      type: 'tool',
      name: 'read',
      input: { path: 'a' },
      callId: 'c1',
    });
    await expect(make('').next(request, signal())).resolves.toMatchObject({ input: {} });
    await expect(make('{oops').next(request, signal())).rejects.toThrow('Invalid tool arguments.');
    await expect(make('[1]').next(request, signal())).rejects.toThrow('Invalid tool arguments.');
  }
});

test('a malformed reply right after a provider compaction keeps the compaction', async () => {
  const store = new Store(crypto.randomUUID());
  let broken = false;
  const model: Model = {
    async compact() {
      broken = true;
      return [{ type: 'compaction', encrypted_content: 'opaque' }];
    },
    async next(request) {
      if (broken) {
        broken = false;
        throw new Error('Invalid tool arguments.');
      }
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
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'One');
  await runtime.run(c.id);
  await runtime.submit(c.id, 'Two');
  await runtime.run(c.id);
  const saved = (await store.get<Conversation>('conversation:' + c.id))!;
  expect(saved.messages.at(-1)?.text).toBe('Invalid tool arguments.');
  expect((await modelInput(store, c.id))!.some((item) => item.type === 'compaction')).toBe(true);
  expect(await store.get('no-server-compact:chatgpt:')).toBeUndefined();
});
