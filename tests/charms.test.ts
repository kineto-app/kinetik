import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';

test.each(['inline', 'split', 'text-only'])(
  'Charms imports %s skill pages and continuations, refreshes dynamic skills and keeps replacements together',
  async (format) => {
    const response = (data: Record<string, unknown>, bodyField?: string) => {
      if (format === 'inline') return { structuredContent: data };
      const metadata = { ...data };
      const body = bodyField ? metadata[bodyField] : undefined;
      if (bodyField) delete metadata[bodyField];
      return {
        ...(format === 'split' ? { structuredContent: metadata } : {}),
        content: [
          { type: 'text', text: JSON.stringify(metadata) },
          ...(body === undefined ? [] : [{ type: 'text', text: body }]),
        ],
      };
    };
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
      'charms_files_delete',
    ];
    const definitions = Object.fromEntries(
      names.map((name) => [
        name,
        {
          description: name,
          inputSchema: { type: 'object' },
          // As the Charms server annotates them: every write and command is destructive.
          approval: !['charms_files_read', 'charms_files_list'].includes(name),
          execute: vi.fn(async () => ({
            structuredContent: { status: 'running', job_id: 'job-1' },
          })),
        },
      ]),
    );
    const call = vi.fn(async (name: string, input: { cursor?: string; name?: string }) => {
      if (name === 'charms_skill_find')
        return response(
          input.cursor
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
        );
      if (name === 'charms_skill_load')
        return response(
          {
            path: '.agents/skills/' + input.name,
            skill_md: 'start',
            next: { tool: 'charms_files_read', arguments: { path: 'skill', offset_bytes: 5 } },
          },
          'skill_md',
        );
      return response({ content: 'end', truncated: false }, 'content');
    });
    const plugin = await new Function('host', code)({
      settings: { url: 'https://charms.test' },
      mcp: () => ({ tools: async () => definitions, call }),
    });
    const first = await plugin.skills.sync(undefined, new AbortController().signal);
    expect(first.skills).toHaveLength(2);
    expect(first.skills[0].content).toContain('startend');
    expect(plugin.tools.charms_skill_find).toBeUndefined();
    // Only deleting a file asks for approval; commands and writes in the sandbox do not.
    expect(
      Object.entries(plugin.tools)
        .filter(([, tool]) => (tool as { approval?: boolean }).approval)
        .map(([name]) => name),
    ).toEqual(['charms_files_delete']);
    expect(Object.keys(plugin.replacements)).toEqual([
      'exec',
      'read',
      'write',
      'edit',
      'list',
      'show_file',
    ]);
    expect(plugin.replacements.show_file).toBeNull();
    call.mockClear();
    await plugin.skills.sync(first, new AbortController().signal);
    expect(
      call.mock.calls.filter(([name]) => name === 'charms_skill_load').map(([, args]) => args.name),
    ).toEqual(['kineto.connections']);
    const checkpoint = vi.fn();
    await plugin.tools.charms_exec.execute({}, { checkpoint });
    expect(checkpoint).toHaveBeenCalledWith('job-1');
    expect(plugin.tools.charms_exec.timeoutMs).toBe(60000);
    expect(plugin.tools.charms_exec.command).toBe(true);
    expect(plugin.tools.charms_files_read.readOnly({ path: 'a' })).toBe(true);
    expect(plugin.tools.charms_files_read.readOnly({ path: 'a', share: true })).toBe(false);
    await plugin.tools.charms_exec.execute(
      { command: 'long job' },
      { checkpoint, background: true },
    );
    expect(definitions.charms_exec.execute).toHaveBeenLastCalledWith(
      { command: 'long job', background: true },
      expect.objectContaining({ background: true }),
    );
  },
);

test.each([204, 202])(
  'Charms sends attachment bytes through its existing upload API (%i)',
  async (status) => {
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
      'charms_files_upload',
    ];
    const call = vi.fn(async (name: string, args: any) => {
      if (name === 'charms_files_upload')
        return {
          structuredContent: {
            upload_url: 'https://charms.example.com/api/charms/uploads/capability',
            method: 'PUT',
            path: args.path,
            max_bytes: 25000000,
          },
        };
      if (name === 'charms_job') return { structuredContent: { status: 'completed' } };
      throw new Error('Unexpected tool ' + name);
    });
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      status === 204
        ? new Response(null, { status })
        : Response.json({ job_id: 'upload-job' }, { status }),
    );
    vi.stubGlobal('fetch', request);
    try {
      const plugin = await new Function('host', code)({
        settings: { url: 'https://charms.example.com/mcp' },
        mcp: () => ({
          tools: async () =>
            Object.fromEntries(names.map((name) => [name, { execute: async () => ({}) }])),
          call,
        }),
      });
      const bytes = new Uint8Array([0, 128, 255]);
      const result = await plugin.files.upload(
        { id: 'attachment-1', name: 'photo.png', bytes },
        new AbortController().signal,
      );
      expect(result.path).toBe('files/attachments/attachment-1/photo.png');
      expect(request.mock.calls[0][1]).toMatchObject({
        method: 'PUT',
        credentials: 'omit',
        redirect: 'error',
        body: bytes,
      });
      expect((request.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Authorization');
      expect(call.mock.calls.filter(([name]) => name === 'charms_job')).toHaveLength(
        status === 202 ? 1 : 0,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test('Charms loads skills a few at a time and keeps catalog order', async () => {
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
    names.map((name) => [name, { description: name, inputSchema: { type: 'object' } }]),
  );
  const catalog = Array.from({ length: 20 }, (_, index) => ({
    name: 'skill-' + index,
    description: 'Skill ' + index,
    charm_version: 'v1',
  }));
  let running = 0;
  let most = 0;
  let fail = '';
  const loaded: string[] = [];
  const call = vi.fn(async (name: string, input: { name?: string }) => {
    if (name === 'charms_skill_find')
      return {
        structuredContent: { catalog_version: '1', total_count: catalog.length, charms: catalog },
      };
    running++;
    most = Math.max(most, running);
    // Later skills answer sooner, so completion order differs from catalog order.
    await new Promise((resolve) => setTimeout(resolve, 40 - Number(input.name!.slice(6))));
    running--;
    loaded.push(input.name!);
    if (input.name === fail) throw new Error('load failed');
    return {
      structuredContent: { path: 'skills/' + input.name, skill_md: '# ' + input.name },
    };
  });
  const plugin = await new Function('host', code)({
    settings: { url: 'https://charms.test' },
    mcp: () => ({ tools: async () => definitions, call }),
  });
  const snapshot = await plugin.skills.sync(undefined, new AbortController().signal);
  expect(most).toBe(6);
  expect(snapshot.skills.map((skill: { name: string }) => skill.name)).toEqual(
    catalog.map((entry) => entry.name),
  );
  expect(snapshot.skills[3].content).toContain('# skill-3');

  // A failed load stops the rest instead of loading every remaining skill.
  fail = 'skill-0';
  loaded.length = 0;
  await expect(plugin.skills.sync(undefined, new AbortController().signal)).rejects.toThrow(
    'load failed',
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(loaded.length).toBeLessThan(catalog.length);
});
