import { expect, test } from 'vitest';
import { collectRuns } from '../src/ui/tool-activity';
import type { Message } from '../src/core/types';

let clock = 0;
const msg = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({
  id,
  role,
  text: id,
  createdAt: (clock += 1000),
  ...extra,
});
const ids = (messages: Message[]) => messages.map((m) => m.id);

test('narration and a message sent meanwhile stay in the run; its final reply ends it', () => {
  const runs = collectRuns([
    msg('ask', 'user'),
    msg('narration', 'assistant'),
    msg('step', 'tool', { tool: 'exec · local' }),
    msg('steer', 'user'),
    msg('final', 'assistant', { durationMs: 4000 }),
    msg('next', 'user'),
    msg('reply', 'assistant', { durationMs: 1000 }),
  ]);
  expect(runs.map((run) => [run.user.id, run.final?.id])).toEqual([
    ['ask', 'final'],
    ['next', 'reply'],
  ]);
});

test('background work that finishes after a later request belongs to the run that started it', () => {
  const start = msg('start', 'tool', {
    tool: 'background · local',
    text: JSON.stringify({ id: 'job-1', state: 'running' }),
  });
  const runs = collectRuns([
    msg('make', 'user'),
    start,
    msg('started', 'assistant', { durationMs: 2000 }),
    msg('other', 'user'),
    msg('answer', 'assistant', { durationMs: 1000 }),
    msg('background-completed:job-1', 'notice', { visibility: 'internal', source: 'background' }),
    msg('render', 'tool', { tool: 'render · charms', visibility: 'internal' }),
    msg('done', 'assistant', { durationMs: 3000 }),
    msg('after', 'user'),
  ]);
  const [make, other, after] = runs;
  expect(make.final?.id).toBe('done');
  expect(ids(make.messages)).toEqual([
    'start',
    'started',
    'background-completed:job-1',
    'render',
    'done',
  ]);
  expect([...make.jobs]).toEqual(['job-1']);
  expect(other.final?.id).toBe('answer');
  expect(ids(other.messages)).toEqual(['answer']);
  expect(after.user.id).toBe('after');
});
