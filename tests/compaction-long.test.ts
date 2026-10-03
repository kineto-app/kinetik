import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { estimateTokens, shortenOutputs, splitPoint } from '../src/core/compaction';
import { modelInput } from './model-input';
import type { Model, ModelRequest, ModelStep } from '../src/core/types';

type Item = Record<string, unknown>;
const big = (n: number) => 'x'.repeat(n);
/** One user request followed by `steps` tool steps, each with an output of `size` characters. */
function longTurn(steps: number, size: number): Item[] {
  const items: Item[] = [{ role: 'user', content: 'Do the long task' }];
  for (let i = 0; i < steps; i++)
    items.push(
      { type: 'function_call', call_id: 'c' + i, name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c' + i, output: big(size) },
    );
  return items;
}
/** Every output in `input` follows its call, and every call has its output. */
const paired = (input: Item[]) => {
  const calls = new Set(input.filter((i) => i.type === 'function_call').map((i) => i.call_id));
  const outputs = input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id);
  return outputs.every((id) => calls.has(id)) && calls.size === outputs.length;
};

test('one long turn is cut at a step boundary that leaves a tail within the budget', () => {
  const input = longTurn(20, 4000);
  const cut = splitPoint(input, 10_000);
  expect(cut).toBeGreaterThan(1);
  expect(input[cut].type).toBe('function_call');
  expect(input[cut - 1].type).toBe('function_call_output');
  expect(estimateTokens(input.slice(cut))).toBeLessThanOrEqual(10_000);
  // A short turn still keeps everything from its request on.
  expect(splitPoint(longTurn(2, 100), 10_000)).toBe(0);
});

test('old long tool outputs keep their start and end; the kept tail is untouched', () => {
  const input = longTurn(4, 5000);
  const shortened = shortenOutputs(input, 6);
  expect(String(shortened[2].output)).toContain('characters left out to save room');
  expect(String(shortened[2].output).length).toBeLessThan(2000);
  expect(shortened[6]).toBe(input[6]);
  expect(shortened[8]).toBe(input[8]);
});

/** A model that keeps reading until stopped, reporting a nearly full window; summaries answer at once. */
function busyModel(steps: number, window: number, summarise?: () => Promise<string>, size = 3000) {
  const seen: ModelRequest[] = [];
  let step = 0;
  const model: Model = {
    async next(request) {
      if (request.message.startsWith('Summarise the conversation'))
        return { type: 'text', text: await (summarise?.() ?? 'Notes so far.') };
      seen.push(request);
      const usage = { input: estimateTokens(request.history), output: 10 };
      if (step++ >= steps) return { type: 'text', text: 'Done.', usage, contextWindow: window };
      return {
        type: 'tool',
        name: 'exec',
        input: { command: `printf '${step}${big(size)}'` },
        callId: 'c' + step,
        items: [{ type: 'function_call', call_id: 'c' + step, name: 'exec', arguments: '{}' }],
        usage,
        contextWindow: window,
      } as ModelStep;
    },
  };
  return { model, seen };
}

test('a single long task is compacted inside its turn instead of overflowing', async () => {
  const store = new Store(crypto.randomUUID());
  const { model, seen } = busyModel(30, 12_000);
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Do the long task');
  await runtime.run(c.id);
  const input = (await modelInput(store, c.id))!;
  expect(input[0]).toMatchObject({ content: expect.stringContaining('Summary of the earlier') });
  expect(input[1]).toEqual({ role: 'user', content: 'Do the long task' });
  expect(paired(input)).toBe(true);
  expect(Math.max(...seen.map((r) => estimateTokens(r.history)))).toBeLessThan(12_000);
});

test('a summary runs in the background and keeps the steps the turn added meanwhile', async () => {
  const store = new Store(crypto.randomUUID());
  let finish!: (text: string) => void;
  let summaries = 0;
  let atStart = -1;
  let requests: ModelRequest[] = [];
  const { model, seen } = busyModel(
    30,
    16_000,
    () => {
      summaries++;
      atStart = requests.length;
      return new Promise<string>((resolve) => (finish = resolve));
    },
    1800,
  );
  requests = seen;
  const runtime = new Runtime(store, undefined, model);
  const c = await runtime.create();
  await runtime.submit(c.id, 'Do the long task');
  const turn = runtime.run(c.id);
  await expect.poll(() => summaries).toBe(1);
  // The turn kept making requests while the summary was still being written.
  await expect.poll(() => seen.length).toBeGreaterThan(atStart + 1);
  finish('Notes so far.');
  await turn;
  const input = (await modelInput(store, c.id))!;
  expect(JSON.stringify(input)).toContain('Notes so far.');
  expect(paired(input)).toBe(true);
  // Steps added after the summary started survived its swap.
  expect(input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'c30' });
});

test('a worker killed while a summary is written loses nothing; the next worker finishes the turn', async () => {
  const name = crypto.randomUUID();
  let summarising = false;
  const { model } = busyModel(30, 12_000, () => {
    summarising = true;
    return new Promise<string>(() => {});
  });
  const first = new Runtime(new Store(name), undefined, model);
  const c = await first.create();
  await first.submit(c.id, 'Do the long task');
  void first.run(c.id);
  const store = new Store(name);
  await expect.poll(() => summarising).toBe(true);
  const before = (await modelInput(store, c.id))!;
  const second = new Runtime(store, undefined, busyModel(2, 1_000_000).model);
  const locks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  try {
    await second.recover();
    await second.run(c.id);
  } finally {
    if (locks) Object.defineProperty(globalThis.navigator, 'locks', locks);
  }
  const after = (await modelInput(store, c.id))!;
  // Either untouched or summarised by the new worker; the request and every call/output pair survive.
  expect(after.length >= before.length || String(after[0].content).startsWith('Summary of')).toBe(
    true,
  );
  expect(after.some((item) => item.content === 'Do the long task')).toBe(true);
  expect(paired(after)).toBe(true);
  expect((await store.get<{ status: string }>('conversation:' + c.id))?.status).toBe('idle');
});
