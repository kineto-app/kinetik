import { expect, test } from 'vitest';
import { ModelFailure } from '../src/core/connection-error';
import { MemoryStore } from '../src/core/memory-store';
import type { Model } from '../src/core/types';
import { ModelRouter, provider, type ModelProvider } from '../src/models/router';

const answer = (name: string): Model => ({
  next: async () => ({ type: 'text', text: name }),
  compact: async () => [{ type: 'compaction', by: name }],
});
const other = (id: string, usable: boolean): ModelProvider => ({
  ...provider(id, answer(id), async () => ({ model: id + '-model' })),
  usable: async () => usable,
});
function setup(options: { chatgpt?: boolean; others?: ModelProvider[] } = {}) {
  const store = new MemoryStore();
  const chatgpt = {
    ...provider('chatgpt', answer('chatgpt'), async () => ({ model: 'gpt', effort: 'medium' })),
    usable: async () => options.chatgpt ?? false,
  };
  const router = new ModelRouter(
    store,
    chatgpt,
    provider('custom', answer('custom'), async () => ({ model: 'local' })),
    async () => options.others ?? [],
  );
  return { store, router };
}
const reply = async (router: ModelRouter) => {
  const step = await router.next(
    { message: 'Hi', instructions: '', tools: [], pin: await router.pin() },
    new AbortController().signal,
  );
  return step.type === 'text' ? step.text : step.type;
};

test('with only the built-in providers, a turn uses ChatGPT unless the custom model is chosen', async () => {
  const { store, router } = setup();
  expect(await router.pin()).toEqual({ provider: 'chatgpt', model: 'gpt', effort: 'medium' });
  await store.put('model-choice', 'custom');
  expect(await router.pin()).toEqual({ provider: 'custom', model: 'local' });
  expect(await reply(router)).toBe('custom');
});

test('a chosen provider is used while it can be, and ChatGPT once signed in otherwise', async () => {
  const kinetik = other('kinetik', true);
  const { store, router } = setup({ chatgpt: true, others: [kinetik] });
  // Signed in to ChatGPT with no choice made: ChatGPT is the default.
  expect((await router.pin()).provider).toBe('chatgpt');
  await store.put('model-choice', 'kinetik');
  expect(await router.pin()).toEqual({ provider: 'kinetik', model: 'kinetik-model' });
  expect(await reply(router)).toBe('kinetik');

  const off = setup({ chatgpt: true, others: [other('kinetik', false)] });
  await off.store.put('model-choice', 'kinetik');
  expect((await off.router.pin()).provider).toBe('chatgpt');
});

test('without ChatGPT a usable provider is the default, and with none ChatGPT asks to sign in', async () => {
  expect(
    (await setup({ others: [other('a', false), other('b', true)] }).router.pin()).provider,
  ).toBe('b');
  expect((await setup({ others: [other('a', false)] }).router.pin()).provider).toBe('chatgpt');
});

test('only ChatGPT compacts, and a turn pinned to a provider that is gone fails plainly', async () => {
  const { router } = setup({ others: [other('kinetik', true)] });
  const signal = new AbortController().signal;
  expect(await router.compact([], { provider: 'chatgpt' }, signal)).toEqual([
    { type: 'compaction', by: 'chatgpt' },
  ]);
  expect(await router.compact([], { provider: 'custom' }, signal)).toBeUndefined();
  expect(await router.compact([], { provider: 'kinetik' }, signal)).toBeUndefined();
  await expect(
    router.next({ message: '', instructions: '', tools: [], pin: { provider: 'gone' } }, signal),
  ).rejects.toBeInstanceOf(ModelFailure);
});
