import { expect, test } from 'vitest';
import { toolOutcome } from '../src/core/tool-outcome';
import { activityBatches, activityExplanation, technicalDetails } from '../src/ui/activity-data';
import { taskLabel } from '../src/ui/task-labels';
import type { Message } from '../src/core/types';

function receipt(
  tool: string,
  input: Record<string, unknown>,
  outcome: NonNullable<Message['activity']>['outcome'] = 'completed',
): Message {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    createdAt: 1,
    text: 'done',
    tool,
    activity: { input, outcome },
  };
}
test('labels namespaced Charms tools and unfamiliar plugins without generic completed steps', () => {
  expect(taskLabel('charms__charms_render · charms', true)).toBe('Prepared preview');
  expect(taskLabel('charms__charms_files_read · charms', true, 5)).toBe('Read 5 files');
  expect(taskLabel('search__web_search · search', true)).toBe('Web search');
  expect(taskLabel('App · increment', true)).toBe('Increment');
});
test('only the same arguments and provider can recover a failed action', () => {
  const failed = receipt('exec · charms', { command: 'build', cwd: '/workspace' }, 'failed');
  const other = receipt('exec · charms', { command: 'pwd' });
  let batch = activityBatches([failed, other])[0];
  expect(batch.failed).toBe(true);
  const succeeded = receipt('exec · charms', { cwd: '/workspace', command: 'build' });
  batch = activityBatches([failed, other, succeeded])[0];
  expect(batch.failed).toBe(false);
  expect(batch.items[0].recovered).toBe(true);
  expect(activityExplanation(batch.items[0])).toContain('later retry');
  expect(activityBatches([failed, { ...succeeded, tool: 'exec · local' }])[0].failed).toBe(true);
  expect(activityBatches([succeeded, failed])[0].failed).toBe(true);
  expect(
    activityBatches([
      { ...failed, activity: { ...failed.activity!, outcome: 'unknown' } },
      succeeded,
    ])[0].failed,
  ).toBe(true);
});
test('counts distinct files and keeps attempts available inside their repeated action', () => {
  const messages = [
    receipt('read · charms', { path: '/a' }),
    receipt('read · charms', { path: '/b' }),
    receipt('read · charms', { path: '/a' }),
  ];
  const batch = activityBatches(messages)[0];
  expect(batch.label).toBe('Read 2 files');
  expect(batch.items).toHaveLength(3);
});
test('legacy receipts render without inventing retry relationships', () => {
  const failed = {
    ...receipt('exec · local', {}, 'failed'),
    activity: undefined,
    text: '\nExit code: 1',
  };
  const success = { ...failed, id: 'other', text: 'done' };
  expect(activityBatches([failed, success])[0].failed).toBe(true);
  expect(
    activityBatches([
      { ...success, tool: 'read · local' },
      { ...success, id: 'read2', tool: 'read · local' },
    ])[0].label,
  ).toBe('Read files');
  expect(
    activityBatches([{ ...success, tool: 'read · local', text: '{"isError":true}' }])[0].failed,
  ).toBe(false);
});
test('protocol failures, nonzero exit codes and running jobs are not marked successful', () => {
  expect(toolOutcome({ isError: true })).toBe('failed');
  expect(toolOutcome({ structuredContent: { exit_code: 2 } }, true)).toBe('failed');
  expect(toolOutcome({ content: [{ type: 'text', text: '{"status":"running"}' }] }, true)).toBe(
    'started',
  );
  expect(toolOutcome('file says error: yes')).toBe('completed');
  expect(toolOutcome('{"isError":true}')).toBe('completed');
  expect(toolOutcome('stdout\nExit code: 3', true)).toBe('failed');
});
test('technical details mask token fields and URLs, ordinary descriptions never include output', () => {
  const message = receipt('charms__charms_render · charms', { token: 'private-token' });
  message.text = JSON.stringify({
    render_token: 'render-secret',
    content: [{ type: 'text', text: JSON.stringify({ render_token: 'nested-secret' }) }],
    url: 'https://example.org/?token=url-secret',
    message: '<script>unsafe()</script>',
  });
  const detail = technicalDetails(message);
  expect(detail).not.toContain('private-token');
  expect(detail).not.toContain('render-secret');
  expect(detail).not.toContain('nested-secret');
  expect(detail).not.toContain('url-secret');
  expect(activityExplanation({ message, outcome: 'completed', recovered: false })).toBe(
    'Prepared a preview.',
  );
});
