import { expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { Runtime } from '../src/core/runtime';
import { MockModel } from '../src/core/mock-model';
import { BackgroundProcesses, type BackgroundProcess } from '../src/core/background';
import type { Conversation, InstalledPlugin, ModelRequest } from '../src/core/types';

const read = async (store: Store, id: string) =>
  (await store.get<Conversation>('conversation:' + id))!;
const completion = (c: Conversation) => c.messages.filter((m) => m.source === 'background').at(-1);
const plugin = (code: string): InstalledPlugin => ({
  manifest: { id: 'remote', name: 'Remote', version: '1', apiVersion: 1, entry: 'plugin.js' },
  source: 'https://example.org/plugin.json',
  resolvedSource: 'https://example.org/plugin.json',
  code,
  digest: 'test',
  enabledAt: 1,
  settings: {},
});

test('background exec ends the turn, then wakes the same conversation once with its result', async () => {
  const store = new Store(crypto.randomUUID());
  const requests: ModelRequest[] = [];
  const model = new MockModel();
  const runtime = new Runtime(store, undefined, {
    next(request, signal) {
      requests.push(request);
      return model.next(request, signal);
    },
  });
  const c = await runtime.create();
  await runtime.submit(
    c.id,
    '/bg sleep 0.6; echo finished > /workspace/result; cat /workspace/result',
  );
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('idle');
  expect((await runtime.background.list(c.id))[0].state).toBe('running');
  const callsBeforeCompletion = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(requests).toHaveLength(callsBeforeCompletion); // No model polling while the process runs.
  await runtime.background.drain();
  const final = await read(store, c.id);
  expect(final.status).toBe('idle');
  expect(completion(final)?.text).toContain('finished');
  expect(completion(final)?.visibility).toBe('internal');
  expect(final.messages.at(-1)?.text).toBe('Background task completed.');
  expect(final.messages.filter((m) => m.id.startsWith('background-completed:'))).toHaveLength(1);
  expect(requests.length).toBe(callsBeforeCompletion + 1);
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/result'))).toBe(
    'finished\n',
  );
  await new Runtime(store).recover();
  expect(
    (await read(store, c.id)).messages.filter((m) => m.id.startsWith('background-completed:')),
  ).toHaveLength(1);
});

test('background exec uses a replacement and waits for provider completion, not the start receipt', async () => {
  const store = new Store(crypto.randomUUID());
  await store.put('plugins', [
    plugin(`return {tools: {exec: {
    description: 'remote', inputSchema: {type: 'object'},
    async execute(input, context) { await context.checkpoint('remote-job'); return {status: 'running'}; },
    async wait(id, signal) { await new Promise(resolve => setTimeout(resolve, 400)); return 'remote finished: ' + id; }
  }}, replacements: {exec: 'exec'}}`),
  ]);
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/bg echo not-local > /workspace/nope');
  await runtime.run(c.id);
  expect((await runtime.background.list(c.id))[0].state).toBe('running');
  await runtime.background.drain();
  expect(completion(await read(store, c.id))?.text).toContain('remote finished: remote-job');
  await expect(runtime.exportFile('/workspace/nope')).rejects.toThrow();
});

test('Stop cancels background work without waking a stopped conversation', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/bg sleep 10; echo wrong > /workspace/late');
  await runtime.run(c.id);
  await runtime.stop(c.id);
  await runtime.background.drain();
  expect((await read(store, c.id)).status).toBe('stopped');
  expect((await runtime.background.list(c.id))[0].state).toBe('cancelled');
  expect((await read(store, c.id)).messages.at(-1)?.role).toBe('notice');
  await expect(runtime.exportFile('/workspace/late')).rejects.toThrow();
});

async function seed(
  store: Store,
  runtime: Runtime,
  state: BackgroundProcess['state'] = 'running',
  plugins: InstalledPlugin[] = [],
) {
  const c = await runtime.create();
  const job: BackgroundProcess = {
    id: 'job',
    conversationId: c.id,
    tool: 'exec',
    provider: plugins.length ? 'remote' : 'local',
    plugins,
    input: { command: 'echo duplicate > /workspace/duplicate' },
    state,
    deadline: Date.now() + 10000,
  };
  await store.put('background:job', job);
  return { c, job };
}

test('worker restart reports a lost local process and never replays its command', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const { c } = await seed(store, runtime);
  await runtime.recover();
  expect((await runtime.background.list(c.id))[0].state).toBe('interrupted');
  expect(completion(await read(store, c.id))?.text).toContain('was not restarted');
  await expect(runtime.exportFile('/workspace/duplicate')).rejects.toThrow();
});

test('restart reconnects to a remote job without invoking execute again', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const { c, job } = await seed(store, runtime, 'running', [
    plugin(`return {tools: {exec: {
    description: 'remote', inputSchema: {type: 'object'},
    async execute() { throw new Error('DUPLICATE EXECUTION'); },
    async recover(id) { return {done: false}; },
    async wait(id) { return 'reconnected ' + id; }
  }}, replacements: {exec: 'exec'}}`),
  ]);
  await store.put('background:job', { ...job, operationId: 'existing-operation' });
  await runtime.recover();
  await runtime.background.drain();
  expect(completion(await read(store, c.id))?.text).toContain('reconnected existing-operation');
  expect((await runtime.background.list(c.id))[0].state).toBe('completed');
});

test('a crash before the start receipt is saved recovers the existing job and delivers its outbox once', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const { c, job } = await seed(store, runtime, 'completed');
  await store.put('background:job', { ...job, result: 'already done' });
  await runtime.submit(c.id, '/bg echo duplicate');
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    activeMessage: value!.pending[0],
    pending: [],
    call: {
      id: 'job',
      name: 'background',
      provider: 'local',
      input: { action: 'start' },
      state: 'pending',
    },
  }));
  await runtime.recover();
  expect((await read(store, c.id)).status).toBe('idle');
  expect(completion(await read(store, c.id))?.text).toContain('already done');
  // Simulate a crash after enqueueing the completion but before marking it delivered.
  await store.update<BackgroundProcess>('background:job', (value) => ({
    ...value!,
    delivered: false,
  }));
  await runtime.recover();
  expect(
    (await read(store, c.id)).messages.filter((m) => m.id.startsWith('background-completed:')),
  ).toHaveLength(1);
  await expect(runtime.exportFile('/workspace/duplicate')).rejects.toThrow();
});

test('Stop racing with the durable job creation prevents execution', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  const c = await runtime.create();
  let release!: () => void;
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = store.put.bind(store);
  vi.spyOn(store, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('background:')) {
      entered();
      await paused;
    }
    return original(key, value);
  });
  await runtime.submit(c.id, '/bg echo wrong > /workspace/late');
  const running = runtime.run(c.id);
  await saving;
  await runtime.stop(c.id);
  release();
  await running;
  await runtime.background.drain();
  // Allow the aborted tool's persistence continuation to settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await runtime.background.list(c.id))[0].state).toBe('cancelled');
  await expect(runtime.exportFile('/workspace/late')).rejects.toThrow();
});

test('provider failure wakes the conversation with an interruption result', async () => {
  const store = new Store(crypto.randomUUID());
  await store.put('plugins', [
    plugin(`return {tools: {exec: {
    description: 'remote', inputSchema: {type: 'object'},
    async execute() { throw new Error('connection lost'); }
  }}, replacements: {exec: 'exec'}}`),
  ]);
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/bg run');
  await runtime.run(c.id);
  await runtime.background.drain();
  expect((await runtime.background.list(c.id))[0].state).toBe('interrupted');
  expect(completion(await read(store, c.id))?.text).toContain('connection lost');
  expect(completion(await read(store, c.id))?.text).toContain('do not automatically retry');
});

test('background timeout wakes the agent even if a provider ignores abort', async () => {
  const store = new Store(crypto.randomUUID());
  await store.put('plugins', [
    plugin(`return {tools: {exec: {
    description: 'remote', inputSchema: {type: 'object'},
    execute() { return new Promise(() => {}); }
  }}, replacements: {exec: 'exec'}}`),
  ]);
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(
    c.id,
    '/tool background {"action":"start","tool":"exec","input":{},"timeoutMs":1000}',
  );
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('idle');
  await runtime.background.drain();
  expect(completion(await read(store, c.id))?.text).toContain('Background job timed out');
  expect((await runtime.background.list(c.id))[0].state).toBe('interrupted');
});

test('background completion and user steering join the same next model request after a foreground tool', async () => {
  const store = new Store(crypto.randomUUID());
  let toolEntered!: () => void;
  let finishTool!: () => void;
  let finishJob!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    toolEntered = resolve;
  });
  const toolHeld = new Promise<void>((resolve) => {
    finishTool = resolve;
  });
  const jobHeld = new Promise<void>((resolve) => {
    finishJob = resolve;
  });
  const requests: ModelRequest[] = [];
  let modelCalls = 0;
  const runtime = new Runtime(store, undefined, {
    async next(request) {
      requests.push(request);
      switch (++modelCalls) {
        case 1:
          return {
            type: 'tool',
            name: 'background',
            input: { action: 'start', tool: 'exec', input: { command: 'bg' } },
          };
        case 2:
          return {
            type: 'tool',
            name: 'exec',
            input: { command: 'fg' },
            callId: 'foreground',
            items: [
              { type: 'function_call', call_id: 'foreground', name: 'exec', arguments: '{}' },
            ],
          };
        case 3:
          return { type: 'tool', name: 'exec', input: { command: 'follow-up' } };
        default:
          return { type: 'text', text: 'Used the completed job and your correction.' };
      }
    },
  });
  vi.spyOn(runtime.plugins, 'snapshot').mockResolvedValue({
    bindings: {
      exec: {
        provider: 'local',
        tool: {
          description: 'controlled work',
          inputSchema: { type: 'object' },
          async execute(input) {
            if (input.command === 'bg') {
              await jobHeld;
              return 'internal background result';
            }
            toolEntered();
            await toolHeld;
            return 'foreground result';
          },
        },
      },
    },
    sources: [],
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'do the work');
  const running = runtime.run(c.id);
  await toolStarted;
  await runtime.submit(c.id, 'use my correction');
  finishJob();
  await runtime.background.drain();
  expect(modelCalls).toBe(2); // Nothing interrupts the executing foreground tool.
  finishTool();
  await running;
  expect(modelCalls).toBe(4);
  const history = requests[2].history!;
  expect(
    history.some(
      (item) => item.type === 'function_call_output' && item.output === 'foreground result',
    ),
  ).toBe(true);
  expect(history.some((item) => String(item.content).includes('internal background result'))).toBe(
    true,
  );
  expect(history.some((item) => item.content === 'use my correction')).toBe(true);
  const toolMessages = (await read(store, c.id)).messages.filter((m) => m.tool?.startsWith('exec'));
  expect(toolMessages).toHaveLength(2);
  expect(toolMessages.every((m) => m.visibility !== 'internal')).toBe(true);
  expect(completion(await read(store, c.id))?.visibility).toBe('internal');
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe(
    'Used the completed job and your correction.',
  );
});

test('a disconnected completion reply resumes once without repeating completed work', async () => {
  const store = new Store(crypto.randomUUID());
  const model = new MockModel();
  let offline = true;
  const runtime = new Runtime(store, undefined, {
    next(request, signal) {
      if (offline && request.message.startsWith('Background job '))
        throw new TypeError('Failed to fetch');
      return model.next(request, signal);
    },
  });
  const c = await runtime.create();
  await runtime.submit(c.id, '/bg sleep 0.1; echo once >> /workspace/result');
  await runtime.run(c.id);
  await runtime.background.drain();
  expect((await read(store, c.id)).status).toBe('waiting');
  expect((await runtime.background.list(c.id))[0].state).toBe('completed');
  offline = false;
  await runtime.recover();
  await runtime.run(c.id);
  const final = await read(store, c.id);
  expect(final.status).toBe('idle');
  expect(final.messages.at(-1)?.text).toBe('Background task completed.');
  expect(final.messages.filter((m) => m.source === 'background')).toHaveLength(1);
  expect(final.messages.some((m) => m.text === 'Failed to fetch')).toBe(false);
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/result'))).toBe('once\n');
});

test('a disconnected remote wait recovers its job ID even after the original deadline', async () => {
  const store = new Store(crypto.randomUUID());
  await store.put('plugins', [
    plugin(`return {tools: {exec: {
    description: 'remote', inputSchema: {type: 'object'},
    async execute(input, context) { await context.checkpoint('saved-job'); return {status: 'running'}; },
    async wait() { throw new TypeError('Failed to fetch'); },
    async recover(id) { return {done: true, result: 'recovered ' + id}; }
  }}, replacements: {exec: 'exec'}}`),
  ]);
  const runtime = new Runtime(store);
  const c = await runtime.create();
  await runtime.submit(c.id, '/bg work');
  await runtime.run(c.id);
  await runtime.background.drain();
  const job = (await runtime.background.list(c.id))[0];
  expect(job.state).toBe('waiting');
  expect(completion(await read(store, c.id))).toBeUndefined();
  await store.put('background:' + job.id, { ...job, deadline: Date.now() - 1000 });
  await runtime.recover();
  await runtime.background.drain();
  expect(completion(await read(store, c.id))?.text).toContain('recovered saved-job');
  expect((await runtime.background.list(c.id))[0].state).toBe('completed');
});

test('Stop during a connection interruption stays stopped on return', async () => {
  const store = new Store(crypto.randomUUID());
  let calls = 0;
  const runtime = new Runtime(store, undefined, {
    next() {
      calls++;
      throw new TypeError('Failed to fetch');
    },
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'hello');
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('waiting');
  await runtime.stop(c.id);
  await runtime.recover();
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('stopped');
  expect(calls).toBe(1);
});

test('cancelling while a provider reconnects cannot resurrect its job', async () => {
  const store = new Store(crypto.randomUUID());
  const job: BackgroundProcess = {
    id: 'job',
    conversationId: 'chat',
    tool: 'exec',
    provider: 'remote',
    plugins: [],
    input: {},
    state: 'waiting',
    operationId: 'remote-job',
    deadline: Date.now() + 60000,
  };
  await store.put('background:job', job);
  const recover = vi.fn(async () => ({ done: true, result: 'done' }));
  const binding = {
    provider: 'remote',
    tool: {
      description: 'Remote',
      inputSchema: {},
      execute: async () => '',
      recover,
      cancel: async () => {},
    },
  };
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const jobs = new BackgroundProcesses(store, {
    async resolve() {
      if (++calls === 1) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return binding;
    },
    wake: async () => {},
    changed: () => {},
  });
  const reconnect = jobs.recover();
  await ready;
  await jobs.cancel(job);
  release();
  await reconnect;
  await jobs.drain();
  expect((await jobs.list('chat'))[0].state).toBe('cancelled');
  expect(recover).not.toHaveBeenCalled();
});

test('a rejected background tool returns to the agent so it can correct the request', async () => {
  const store = new Store(crypto.randomUUID());
  let step = 0;
  const runtime = new Runtime(store, undefined, {
    async next(request) {
      if (++step === 1)
        return {
          type: 'tool',
          name: 'background',
          callId: 'invalid',
          input: { action: 'start', tool: 'missing_tool', input: {} },
        };
      if (step === 2) {
        expect(JSON.parse(request.result!)).toMatchObject({
          started: false,
          error: 'Tool is unavailable for background execution.',
        });
        return {
          type: 'tool',
          name: 'write',
          input: { path: '/workspace/corrected', content: 'done' },
        };
      }
      return { type: 'text', text: 'Done.' };
    },
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Do the work');
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('idle');
  expect(await runtime.background.list(c.id)).toEqual([]);
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/corrected'))).toBe('done');
});

test('opening an older chat repairs the known pre-dispatch background rejection', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store, undefined, {
    async next(request) {
      expect(JSON.parse(request.result!)).toMatchObject({ started: false });
      return { type: 'text', text: 'Continued automatically.' };
    },
  });
  const c = await runtime.create();
  await runtime.submit(c.id, 'Create slides');
  await store.update<Conversation>('conversation:' + c.id, (value) => ({
    ...value!,
    status: 'needs_review',
    activeMessage: value!.pending[0],
    pending: [],
    call: {
      id: 'rejected',
      callId: 'call',
      name: 'background',
      provider: 'local',
      input: { action: 'start', tool: 'missing' },
      state: 'unknown',
    },
    messages: [
      ...value!.messages,
      {
        id: 'notice',
        role: 'notice',
        text: 'Tool outcome needs review: Tool is unavailable for background execution.. Changes may already have happened.',
        createdAt: Date.now(),
      },
    ],
  }));
  await runtime.recover();
  expect((await read(store, c.id)).status).toBe('queued');
  await runtime.run(c.id);
  expect((await read(store, c.id)).status).toBe('idle');
  expect((await read(store, c.id)).messages.find((m) => m.id === 'notice')?.visibility).toBe(
    'internal',
  );
  expect((await read(store, c.id)).messages.at(-1)?.text).toBe('Continued automatically.');
});
