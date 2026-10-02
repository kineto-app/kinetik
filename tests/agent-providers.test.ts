import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { MockModel } from '../src/core/mock-model';
import { ModelRouter, providersAction } from '../src/core/model-router';
import { PiModel, fromPiMessage, providerKey, toPiMessages } from '../src/core/pi-model';
import { forOpenAI } from '../src/core/openai-model';
import { exportArchive } from '../src/core/archive';
import { modelInput } from './model-input';
// @ts-expect-error The fixture is plain JavaScript shared with the browser tests.
import { providerFixture, providerRequests } from './provider-fixture.mjs';
import type { Conversation } from '../src/core/types';

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const body = () =>
      new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => resolve(data));
      });
    void providerFixture(req, res, body).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}/providers/`;
});
afterAll(() => server.close());

async function setup(provider: 'anthropic' | 'google', apiKey: string, model: string) {
  const store = new Store(crypto.randomUUID());
  await providersAction(store, { action: 'save', provider, apiKey, baseUrl: base + provider });
  await providersAction(store, { action: 'choose', provider, model });
  const events: { type: string; text?: string }[] = [];
  const runtime = new Runtime(
    store,
    (event) => event && events.push(event),
    new ModelRouter(
      store,
      new MockModel(),
      new PiModel(async (p) => (await store.get(providerKey(p))) ?? undefined),
    ),
  );
  return { store, runtime, events };
}
const read = async (store: Store, id: string) =>
  (await store.get<Conversation>('conversation:' + id))!;

test('a Claude turn streams thinking and text, and records usage and the reply', async () => {
  const { store, runtime, events } = await setup(
    'anthropic',
    'sk-ant-test-key-123',
    'claude-sonnet-5-5',
  );
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello Claude');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.messages.at(-1)?.text).toBe('Hello from Claude. How can I help with your carousel?');
  expect(saved.messages.at(-1)?.usage).toMatchObject({ input: 2000, output: 42, cached: 200 });
  expect(events.some((e) => e.type === 'reasoning' && e.text?.includes('friendly answer'))).toBe(
    true,
  );
  expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(3);
  const request = providerRequests.at(-1);
  expect(request.body.model).toBe('claude-sonnet-5-5');
  expect(request.body.system?.[0]?.text ?? request.body.system).toContain('You are Kinetik');
});

test('a Claude tool call runs, and its thinking signature is replayed to Claude only', async () => {
  const { store, runtime } = await setup('anthropic', 'sk-ant-test-key-123', 'claude-sonnet-5-5');
  const c = await runtime.create();
  await runtime.submit(c.id, 'Claude, list my files');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe(
    'Claude looked at your workspace and it is ready.',
  );
  const followUp = providerRequests
    .at(-1)
    .body.messages.filter((m: { role: string }) => m.role !== 'system');
  const assistant = followUp.find((m: { role: string }) => m.role === 'assistant');
  expect(assistant.content[0]).toMatchObject({ type: 'thinking', signature: 'sig-claude-1' });
  expect(assistant.content[1]).toMatchObject({
    type: 'tool_use',
    id: 'toolu_1',
    input: { path: '/workspace' },
  });
  expect(followUp.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  // The stored history is Responses-shaped; OpenAI gets it without Claude's private parts.
  const input = (await modelInput(store, c.id))!;
  expect(input.map((i) => i.type ?? i.role)).toEqual([
    'user',
    'pi_thinking',
    'function_call',
    'function_call_output',
    'message',
  ]);
  expect(forOpenAI(input)!.map((i) => i.type ?? i.role)).toEqual([
    'user',
    'function_call',
    'function_call_output',
    'message',
  ]);
  expect(forOpenAI(input)![1]).not.toHaveProperty('provider');
});

test('a Gemini turn calls a tool with its thought signature and answers', async () => {
  const { store, runtime } = await setup('google', 'gemini-test-key-123', 'gemini-3.8-flash');
  const c = await runtime.create();
  await runtime.submit(c.id, 'Gemini, list my files');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Gemini checked your workspace.');
  const request = providerRequests.at(-1);
  expect(request.path).toContain('gemini-3.8-flash:streamGenerateContent');
  const call = request.body.contents
    .flatMap((c: { parts: unknown[] }) => c.parts)
    .find((p: { functionCall?: unknown }) => p.functionCall);
  expect(call).toMatchObject({ thoughtSignature: 'c2lnLWdlbWluaS0x' });
});

test('a wrong key asks the user to fix it in Settings', async () => {
  const { store, runtime } = await setup('anthropic', 'sk-ant-wrong-key', 'claude-sonnet-5-5');
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello Claude');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.status).toBe('waiting');
  expect(saved.waitingFor).toBe('signin');
});

test('history moves between providers: OpenAI-only items are dropped for Claude', () => {
  const history = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Look' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
      ],
    },
    { type: 'reasoning', encrypted_content: 'opaque' },
    { type: 'compaction', encrypted_content: 'opaque' },
    { type: 'function_call', call_id: 'c1', name: 'read_x', arguments: '{"path":"/a"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'Error: missing' },
    { type: 'pi_thinking', provider: 'google', thinking: 'hm', signature: 'g' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
  ];
  const messages = toPiMessages(history, {
    api: 'anthropic-messages',
    provider: 'anthropic',
    id: 'x',
  });
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  expect(messages[0].content).toEqual([
    { type: 'text', text: 'Look' },
    { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
  ]);
  expect(messages[2]).toMatchObject({ toolName: 'read_x', isError: true });
  expect(JSON.stringify(messages)).not.toContain('opaque');
  expect(JSON.stringify(messages)).not.toContain('"g"');
  // And back: a pi reply becomes Responses items again.
  const items = fromPiMessage(
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hi' },
        { type: 'toolCall', id: 't1', name: 'list_x', arguments: { path: '/' } },
      ],
    } as never,
    'anthropic',
  );
  expect(items[1]).toEqual({
    type: 'function_call',
    call_id: 't1',
    name: 'list_x',
    arguments: '{"path":"/"}',
    provider: 'anthropic',
  });
});

test('a turn keeps the model it started with, and keys never leave in an export', async () => {
  const { store } = await setup('anthropic', 'sk-ant-test-key-123', 'claude-sonnet-5-5');
  const archive = JSON.stringify(await exportArchive(store));
  expect(archive).not.toContain('sk-ant-test-key-123');
  const router = new ModelRouter(store, new MockModel(), new MockModel());
  expect(await router.pin()).toBe('anthropic:claude-sonnet-5-5');
  await providersAction(store, { action: 'remove', provider: 'anthropic' });
  expect(await router.pin()).toBeUndefined();
  await expect(
    providersAction(store, { action: 'choose', provider: 'anthropic', model: 'claude-sonnet-5-5' }),
  ).rejects.toThrow('API key');
  await expect(
    providersAction(store, {
      action: 'save',
      provider: 'anthropic',
      apiKey: 'sk-ant-test-key-123',
      baseUrl: 'http://evil.example',
    }),
  ).rejects.toThrow('HTTPS');
});
