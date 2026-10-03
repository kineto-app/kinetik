import { expect, test, vi } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ConnectionError } from '../src/core/connection-error';
import { McpClient } from '../src/plugins/mcp';
import { modelInput } from './model-input';
import type {
  Binding,
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
const call = (name: string, input: Record<string, unknown>): ModelStep => ({
  type: 'tool',
  name,
  input,
  callId: 'c',
});
const batch = (...calls: [string, Record<string, unknown>][]): ModelStep => ({
  type: 'tools',
  calls: calls.map(([name, input], i) => ({ name, input, callId: 'b' + i })),
});
const remote = (tool: Partial<ToolDefinition>): Binding => ({
  provider: 'charms',
  tool: {
    description: 'Remote tool',
    inputSchema: { type: 'object' },
    execute: async () => 'remote result',
    ...tool,
  },
});
/** Adds plugin tools to every snapshot the runtime takes. */
function withTools(runtime: Runtime, tools: Record<string, Binding>) {
  const snapshot = runtime.plugins.snapshot.bind(runtime.plugins);
  runtime.plugins.snapshot = async (builtins, records) => {
    const result = await snapshot(builtins, records);
    Object.assign(result.bindings, tools);
    return result;
  };
}

test('remote read-only tools run together in one batch', async () => {
  const store = new Store(crypto.randomUUID());
  const execute = vi.fn(async (input: Record<string, unknown>) => 'read ' + input.path);
  const { model, seen } = scripted([
    () => batch(['charms__files_read', { path: 'a' }], ['charms__files_read', { path: 'b' }]),
    () => say('Read both.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withTools(runtime, { charms__files_read: remote({ readOnly: true, execute }) });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Read');
  await runtime.run(c.id);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(seen[1].result).toContain('charms__files_read: read a');
  expect((await read(store, c.id)).status).toBe('idle');
});

test('the helper gets remote reads, but not widgets, approval tools, model-hidden tools or itself', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = scripted([
    () => call('delegate', { task: 'Find the brief' }),
    () => say('The brief is in a.md.'),
    () => say('Found it.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withTools(runtime, {
    charms__files_read: remote({ readOnly: true }),
    charms__render: remote({
      readOnly: true,
      app: { resource: async () => ({}) as never, call: async () => ({}) },
    }),
    charms__files_share: remote({ readOnly: true, approval: true }),
    charms__widget_state: remote({ readOnly: true, visibility: ['app'] }),
    charms__files_write: remote({}),
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Research');
  await runtime.run(c.id);
  expect(seen[1].tools.sort()).toEqual(['charms__files_read', 'list', 'read', 'read_skill']);
});

test('a read that needs approval for this input does not run in a batch', async () => {
  const store = new Store(crypto.randomUUID());
  const execute = vi.fn(async () => 'link');
  const { model, seen } = scripted([
    () => batch(['charms__files_read', { share: true }], ['list', { path: '/' }]),
    () => say('Asked.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withTools(runtime, {
    charms__files_read: remote({
      readOnly: true,
      approval: (input) => input.share === true,
      execute,
    }),
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Share');
  await runtime.run(c.id);
  expect(execute).not.toHaveBeenCalled();
  expect(seen[1].result).toContain(
    'charms__files_read: Error: charms__files_read may change something here',
  );
});

test('a read that publishes for this input does not run in a batch', async () => {
  const store = new Store(crypto.randomUUID());
  const execute = vi.fn(async () => 'link');
  const { model, seen } = scripted([
    () => batch(['read', { path: 'a', share: true }], ['list', { path: '/' }]),
    () => say('Asked.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withTools(runtime, {
    read: remote({ readOnly: (input) => input.share !== true, execute }),
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Share');
  await runtime.run(c.id);
  expect(execute).not.toHaveBeenCalled();
  expect(seen[1].result).toContain('read: Error: read may change something here');
});

test('a lost connection inside the helper pauses the turn instead of asking for review', async () => {
  const store = new Store(crypto.randomUUID());
  const { model } = scripted([
    () => call('delegate', { task: 'Read the brief' }),
    () => call('charms__files_read', { path: 'brief.md' }),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withTools(runtime, {
    charms__files_read: remote({
      readOnly: true,
      execute: async () => {
        throw new ConnectionError('offline');
      },
    }),
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Research');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.status).not.toBe('needs_review');
  expect(saved.waitingFor).toBe('connection');
  expect(saved.call).toMatchObject({ name: 'delegate', state: 'pending' });
});

test('a lost connection during a batch pauses the turn and records nothing', async () => {
  const store = new Store(crypto.randomUUID());
  const { model } = scripted([() => batch(['charms__files_read', {}], ['list', { path: '/' }])]);
  const runtime = new Runtime(store, undefined, model);
  withTools(runtime, {
    charms__files_read: remote({
      readOnly: true,
      execute: async () => {
        throw new ConnectionError('offline');
      },
    }),
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Read');
  await runtime.run(c.id);
  const saved = await read(store, c.id);
  expect(saved.waitingFor).toBe('connection');
  expect((await modelInput(store, c.id))!.some((i) => i.type === 'function_call_output')).toBe(
    false,
  );
});

test('after a restart a pending local read runs again, but a remote read is never re-run', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store, undefined, scripted([]).model);
  const pending = async (provider: string, name: string) => {
    const c = await runtime.create();
    await store.update<Conversation>('conversation:' + c.id, (value) => ({
      ...value!,
      status: 'running',
      call: { id: 'x', callId: 'c', name, input: {}, provider, state: 'pending' },
    }));
    return c.id;
  };
  const local = await pending('local', 'read');
  const charms = await pending('charms', 'charms__files_read');
  await runtime.recover();
  expect((await read(store, local)).call).toMatchObject({ state: 'pending', approved: true });
  expect((await read(store, charms)).call?.approved).toBeUndefined();
  expect((await read(store, charms)).call?.state).not.toBe('pending');
});

test("a tool's command flag, not its name, decides that a non-zero exit failed", async () => {
  const store = new Store(crypto.randomUUID());
  const output = async () => 'built\nExit code: 2';
  const { model } = scripted([
    () => call('box__run', { script: 'make' }),
    () => call('box__print', { script: 'make' }),
    () => say('Done.'),
  ]);
  const runtime = new Runtime(store, undefined, model);
  withTools(runtime, {
    box__run: remote({ command: true, execute: output }),
    box__print: remote({ execute: output }),
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Build');
  await runtime.run(c.id);
  const outcomes = (await read(store, c.id)).messages
    .filter((m) => m.role === 'tool')
    .map((m) => m.activity?.outcome);
  expect(outcomes).toEqual(['failed', 'completed']);
});

test("MCP read-only and destructive hints become the tool's effects", async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      if (request.method === 'initialize')
        return Response.json({ id: request.id, result: { protocolVersion: '2025-06-18' } });
      return Response.json({
        id: request.id,
        result: {
          tools: [
            { name: 'look', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
            {
              name: 'drop',
              inputSchema: { type: 'object' },
              annotations: { destructiveHint: true },
            },
          ],
        },
      });
    }),
  );
  try {
    const tools = await new McpClient('https://mcp.example/server').tools();
    expect([tools.look.readOnly, tools.look.approval]).toEqual([true, false]);
    expect([tools.drop.readOnly, tools.drop.approval]).toEqual([false, true]);
  } finally {
    vi.unstubAllGlobals();
  }
});
