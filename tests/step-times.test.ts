import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { loadChat } from './chat';
import type { Model, ModelStep } from '../src/core/types';

const scripted = (steps: ModelStep[]): Model => ({ next: async () => steps.shift()! });

test('a step records how long its tool ran', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(
    store,
    undefined,
    scripted([
      { type: 'tool', name: 'exec', input: { command: 'sleep 0.3' }, callId: 'e' },
      { type: 'text', text: 'Done.' },
    ]),
  );
  const c = await runtime.create();
  await runtime.submit(c.id, 'Wait a moment');
  await runtime.run(c.id);
  const step = (await loadChat(store, c.id)).messages.find((m) => m.role === 'tool');
  expect(step?.durationMs).toBeGreaterThanOrEqual(250);
  expect(step?.durationMs).toBeLessThan(5000);
});
