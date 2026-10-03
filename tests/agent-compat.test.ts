import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { MockModel } from '../src/models/mock';
import { ModelRouter } from '../src/models/router';
import {
  customModelAction,
  customModelKey,
  type CustomModel,
} from '../src/connections/custom-model';
import { CompatModel, toChatMessages } from '../src/models/compat';
import { exportArchive } from '../src/core/archive';
import { modelInput } from './model-input';
// @ts-expect-error The fixture is plain JavaScript shared with the browser tests.
import { compatFixture, compatRequests } from './compat-fixture.mjs';
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
    void compatFixture(req, res, body).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/compat/v1`;
});
afterAll(() => server.close());

async function setup(apiKey: string) {
  const store = new Store(crypto.randomUUID());
  await customModelAction(store, { action: 'save', baseUrl: base, apiKey, model: 'fixture-model' });
  await customModelAction(store, { action: 'choose', use: true });
  const events: { type: string; text?: string }[] = [];
  const runtime = new Runtime(
    store,
    (event) => event && events.push(event),
    new ModelRouter(
      store,
      new MockModel(),
      new CompatModel(async () => (await store.get<CustomModel>(customModelKey)) ?? undefined),
    ),
  );
  return { store, runtime, events };
}
const read = async (store: Store, id: string) =>
  (await store.get<Conversation>('conversation:' + id))!;

test('a custom-model turn streams reasoning and text and records usage', async () => {
  const { store, runtime, events } = await setup('placeholder-compat-key');
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello custom');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.messages.at(-1)?.text).toBe(
    'Hello from the custom model. How can I help with your carousel?',
  );
  expect(saved.messages.at(-1)?.usage).toMatchObject({ input: 1800, output: 25, cached: 100 });
  expect(events.some((e) => e.type === 'reasoning' && e.text?.includes('short answer'))).toBe(true);
  const request = compatRequests.at(-1);
  expect(request.authorization).toBe('Bearer placeholder-compat-key');
  expect(request.body).toMatchObject({ model: 'fixture-model', stream: true });
  expect(request.body.messages[0]).toMatchObject({ role: 'system' });
});

test('a tool call streamed in fragments runs, and its result goes back as a tool message', async () => {
  const { store, runtime } = await setup('placeholder-compat-key');
  const c = await runtime.create();
  await runtime.submit(c.id, 'Custom, list my files');
  await runtime.run(c.id);
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe(
    'The custom model looked at your workspace.',
  );
  const messages = compatRequests.at(-1).body.messages;
  expect(messages.at(-2)).toMatchObject({
    role: 'assistant',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { arguments: '{"path":"/workspace"}' } },
    ],
  });
  expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  expect((await modelInput(store, c.id))!.map((i) => i.type ?? i.role)).toEqual([
    'user',
    'function_call',
    'function_call_output',
    'message',
  ]);
});

test('a wrong key waits for the key and a context error is recognised as overflow', async () => {
  const { store, runtime } = await setup('placeholder-wrong-key');
  const c = await runtime.create();
  await runtime.submit(c.id, 'Hello custom');
  await runtime.run(c.id);
  expect(await read(store, c.id)).toMatchObject({ status: 'waiting', waitingFor: 'signin' });
  const good = await setup('placeholder-compat-key');
  const d = await good.runtime.create();
  await good.runtime.submit(d.id, 'Too long');
  await good.runtime.run(d.id);
  expect((await read(good.store, d.id)).messages.at(-1)?.text).toContain('Start a new chat');
});

test('ChatGPT history reads as Chat Completions; OpenAI-only items are left out', () => {
  const messages = toChatMessages('Be brief.', [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Look' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
      ],
    },
    { type: 'reasoning', encrypted_content: 'opaque' },
    { type: 'compaction', encrypted_content: 'opaque' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
    { type: 'function_call', call_id: 'c1', name: 'read_x', arguments: '{"path":"/a"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'Error: missing' },
  ]);
  expect(messages).toEqual([
    { role: 'system', content: 'Be brief.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      ],
    },
    {
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_x', arguments: '{"path":"/a"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'Error: missing' },
  ]);
});

test('settings rules: endpoints, a kept key, removal, and no key in an export', async () => {
  const { store } = await setup('placeholder-compat-key');
  expect(JSON.stringify(await exportArchive(store))).not.toContain('placeholder-compat-key');
  // Saving again without a key keeps the saved one.
  await customModelAction(store, { action: 'save', baseUrl: base, model: 'other-model' });
  expect(await store.get<CustomModel>(customModelKey)).toMatchObject({
    apiKey: 'placeholder-compat-key',
    model: 'other-model',
  });
  await expect(
    customModelAction(store, { action: 'save', baseUrl: 'http://evil.example/v1', model: 'm' }),
  ).rejects.toThrow('HTTPS');
  const state = await customModelAction(store, { action: 'remove' });
  expect(state).toEqual({ configured: false, chosen: false });
  await expect(customModelAction(store, { action: 'choose', use: true })).rejects.toThrow('Set up');
});
