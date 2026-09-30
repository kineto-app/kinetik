import { expect, test } from 'vitest';
import { Store } from '../src/browser/store';
import { Runtime } from '../src/core/runtime';

test('background task dispatch is durable and repeated ticks do not execute twice', async () => {
  const store = new Store(crypto.randomUUID());
  const runtime = new Runtime(store);
  await runtime.automations.create({
    kind: 'task',
    prompt: '/exec echo line >> /workspace/once',
    maxRuns: 1,
  });
  await Promise.all([runtime.automations.tick(), runtime.automations.tick()]);
  await new Runtime(store).automations.tick();
  expect(new TextDecoder().decode(await runtime.exportFile('/workspace/once'))).toBe('line\n');
  expect((await runtime.automations.list())[0].status).toBe('completed');
});
test('event subscribers receive a redelivered event once and paused routines stay paused', async () => {
  const runtime = new Runtime(new Store(crypto.randomUUID()));
  const first = await runtime.automations.create({
    kind: 'job',
    prompt: 'Event received',
    event: 'inbox.new',
    maxRuns: 3,
  });
  const paused = await runtime.automations.create({
    kind: 'job',
    prompt: 'Paused',
    event: 'inbox.new',
    maxRuns: 3,
  });
  await runtime.automations.setStatus(paused.id, 'paused');
  await runtime.automations.emit('inbox.new', 'payload', 'event-1');
  await runtime.automations.tick();
  await runtime.automations.emit('inbox.new', 'payload', 'event-1');
  await runtime.automations.tick();
  const items = await runtime.automations.list();
  expect(items.find((item) => item.id === first.id)?.runs).toBe(1);
  expect(items.find((item) => item.id === paused.id)?.runs).toBe(0);
});
test('missed scheduled intervals coalesce and goals stop at the run budget', async () => {
  const runtime = new Runtime(new Store(crypto.randomUUID()));
  await runtime.automations.create({ kind: 'job', prompt: 'job', intervalMs: 60000, maxRuns: 2 });
  await runtime.automations.create({ kind: 'goal', prompt: 'goal', maxRuns: 2 });
  await runtime.automations.tick(Date.now() + 3600000);
  await runtime.automations.tick(Date.now() + 3600000);
  await runtime.automations.tick(Date.now() + 3600000);
  const items = await runtime.automations.list();
  expect(items.find((item) => item.kind === 'job')?.runs).toBe(1);
  expect(items.find((item) => item.kind === 'goal')?.status).toBe('completed');
});

test('file monitors establish a baseline and trigger only after content changes', async () => {
  const runtime = new Runtime(new Store(crypto.randomUUID()));
  await runtime.importFile('watch.txt', new TextEncoder().encode('one'));
  await runtime.automations.create({
    kind: 'monitor',
    prompt: 'Review change',
    watchPath: '/workspace/watch.txt',
    intervalMs: 60000,
    maxRuns: 3,
  });
  const now = Date.now();
  await runtime.automations.tick(now);
  await runtime.automations.tick(now + 60001);
  expect((await runtime.automations.list())[0].runs).toBe(0);
  await runtime.importFile('watch.txt', new TextEncoder().encode('two'));
  await runtime.automations.tick(now + 120002);
  expect((await runtime.automations.list())[0].runs).toBe(1);
  await runtime.automations.tick(now + 180003);
  expect((await runtime.automations.list())[0].runs).toBe(1);
});

test('events queued under the same name are delivered separately to every subscriber', async () => {
  const runtime = new Runtime(new Store(crypto.randomUUID()));
  await runtime.automations.create({ kind: 'job', prompt: 'first', event: 'inbox', maxRuns: 3 });
  await runtime.automations.create({ kind: 'job', prompt: 'second', event: 'inbox', maxRuns: 3 });
  await runtime.automations.emit('inbox', 'one', 'one');
  await runtime.automations.emit('inbox', 'two', 'two');
  await runtime.automations.tick();
  await runtime.automations.tick();
  await runtime.automations.tick();
  expect((await runtime.automations.list()).map((item) => item.runs)).toEqual([2, 2]);
});

test('a model can mark its goal complete without cancelling its own tool result', async () => {
  let id = '';
  const runtime = new Runtime(new Store(crypto.randomUUID()), () => {}, {
    next: async (request) =>
      request.result === undefined
        ? { type: 'tool', name: 'automation', input: { action: 'status', id, status: 'completed' } }
        : { type: 'text', text: 'Goal achieved.' },
  });
  id = (await runtime.automations.create({ kind: 'goal', prompt: 'Finish goal', maxRuns: 3 })).id;
  await runtime.automations.tick();
  await runtime.automations.tick();
  expect((await runtime.automations.list())[0]).toMatchObject({ status: 'completed', runs: 1 });
  expect((await runtime.conversations())[0]).toMatchObject({ status: 'idle' });
});
