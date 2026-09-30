import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';

test('Charms imports all skill pages and continuations, refreshes dynamic skills and keeps replacements together', async () => {
  const code = await readFile(
    new URL('../public/plugins/charms/plugin.js', import.meta.url),
    'utf8',
  );
  const names = [
    'charms_exec',
    'charms_files_read',
    'charms_files_write',
    'charms_files_edit',
    'charms_files_list',
    'charms_skill_find',
    'charms_skill_load',
  ];
  const definitions = Object.fromEntries(
    names.map((name) => [
      name,
      {
        description: name,
        inputSchema: { type: 'object' },
        execute: async () => ({ structuredContent: { status: 'running', job_id: 'job-1' } }),
      },
    ]),
  );
  const call = vi.fn(async (name: string, input: { cursor?: string; name?: string }) => {
    if (name === 'charms_skill_find')
      return {
        structuredContent: input.cursor
          ? {
              catalog_version: '1',
              total_count: 2,
              charms: [
                { name: 'kineto.connections', description: 'Connections', charm_version: 'v1' },
              ],
            }
          : {
              catalog_version: '1',
              total_count: 2,
              charms: [{ name: 'test', description: 'Test', charm_version: 'v1' }],
              next: { tool: 'charms_skill_find', arguments: { cursor: 'next' } },
            },
      };
    if (name === 'charms_skill_load')
      return {
        structuredContent: {
          path: '.agents/skills/' + input.name,
          skill_md: 'start',
          next: { tool: 'charms_files_read', arguments: { path: 'skill', offset_bytes: 5 } },
        },
      };
    return { structuredContent: { content: 'end', truncated: false } };
  });
  const plugin = await new Function('host', code)({
    settings: { url: 'https://charms.test' },
    mcp: () => ({ tools: async () => definitions, call }),
  });
  const first = await plugin.skills.sync(undefined, new AbortController().signal);
  expect(first.skills).toHaveLength(2);
  expect(first.skills[0].content).toContain('startend');
  expect(plugin.tools.charms_skill_find).toBeUndefined();
  expect(Object.keys(plugin.replacements)).toEqual(['exec', 'read', 'write', 'edit', 'list']);
  call.mockClear();
  await plugin.skills.sync(first, new AbortController().signal);
  expect(
    call.mock.calls.filter(([name]) => name === 'charms_skill_load').map(([, args]) => args.name),
  ).toEqual(['kineto.connections']);
  const checkpoint = vi.fn();
  await plugin.tools.charms_exec.execute({}, { checkpoint });
  expect(checkpoint).toHaveBeenCalledWith('job-1');
});
