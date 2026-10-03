import { expect, test } from 'vitest';
import { Runtime } from '../src/core/runtime';
import { Store } from '../src/browser/store';
import { ModelRouter } from '../src/models/router';
import type { Model, ModelStep } from '../src/core/types';

const say = (text: string): ModelStep => ({ type: 'text', text });

test('a message queued during a turn uses the model chosen when it starts, not the last one', async () => {
  const store = new Store(crypto.randomUUID());
  const seen: string[] = [];
  const chatgpt: Model = {
    async next(request) {
      seen.push('chatgpt:' + request.message);
      // While the first answer streams, the user picks the custom model and queues a follow-up.
      await store.put('model-choice', 'custom');
      await routed.submit(c.id, 'Then summarise', undefined, [], 'after');
      return say('First answer');
    },
  };
  const custom: Model = {
    async next(request) {
      seen.push('custom:' + request.message);
      return say('Summary');
    },
  };
  const router = new ModelRouter(store, chatgpt, custom);
  const routed = new Runtime(store, undefined, router);
  const c = await routed.create();
  await routed.submit(c.id, 'Start');
  await routed.run(c.id);
  expect(seen).toEqual(['chatgpt:Start', 'custom:Then summarise']);
});
