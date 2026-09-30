import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { Plugins, manifestURL, validateManifest } from '../src/plugins/loader';
import { McpClient } from '../src/plugins/mcp';
afterEach(() => vi.unstubAllGlobals());
test('repo folder and entry-file URLs resolve to one commit, including slash refs', async () => {
  const sha = 'a'.repeat(40);
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith('/commits/feature%2Fbrowser')) return Response.json({ sha });
      return new Response('', { status: 404 });
    }),
  );
  expect(await manifestURL('https://github.com/owner/repo/tree/feature/browser/plugins/demo')).toBe(
    `https://raw.githubusercontent.com/owner/repo/${sha}/plugins/demo/plugin.json`,
  );
  expect(
    await manifestURL('https://github.com/owner/repo/blob/feature/browser/plugins/demo/plugin.js'),
  ).toBe(`https://raw.githubusercontent.com/owner/repo/${sha}/plugins/demo/plugin.json`);
  expect(calls.length).toBeGreaterThan(1);
});
test('installation caches exact code without executing; explicit update retains enable order', async () => {
  const store = new Store(crypto.randomUUID());
  const plugins = new Plugins(store);
  let version = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) =>
      String(url).endsWith('plugin.json')
        ? Response.json({
            id: 'demo',
            name: 'Demo',
            version: String(version),
            apiVersion: 1,
            entry: 'plugin.js',
          })
        : new Response(`throw new Error('not during install ${version}');`),
    ),
  );
  await plugins.install('https://example.com/demo/plugin.js');
  await plugins.enable('demo', true);
  const before = (await plugins.list())[0];
  expect(before.code).toContain('install 1');
  version = 2;
  expect((await plugins.list())[0].code).toContain('install 1');
  await plugins.install(before.source, {}, 'demo');
  const after = (await plugins.list())[0];
  expect(after.enabledAt).toBe(before.enabledAt);
  expect(after.digest).not.toBe(before.digest);
  expect(after.code).toContain('install 2');
});
test('invalid manifests and ambiguous source transports are rejected', async () => {
  expect(() =>
    validateManifest({ id: 'x', name: 'X', version: '1', apiVersion: 1, entry: '../remote.js' }),
  ).toThrow();
  await expect(manifestURL('http://example.com/plugin.json')).rejects.toThrow('HTTPS');
});
test('MCP uses negotiated protocol, session header, pagination and stops at its SSE response', async () => {
  const seen: { method: string; headers: Headers }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      seen.push({ method: request.method, headers });
      if (request.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      if (request.method === 'initialize')
        return Response.json(
          { id: request.id, result: { protocolVersion: '2025-06-18' } },
          { headers: { 'Mcp-Session-Id': 'session' } },
        );
      if (request.method === 'tools/list')
        return Response.json({
          id: request.id,
          result: request.params.cursor
            ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] }
            : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }], nextCursor: 'page2' },
        });
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const part of [
              `event: message\r`,
              `\ndata: ${JSON.stringify({ id: request.id, result: { content: [{ type: 'text', text: 'hello' }] } })}\r`,
              '\n\r',
              '\n',
            ])
              controller.enqueue(new TextEncoder().encode(part));
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
  );
  const client = new McpClient('https://mcp.example/server', 'placeholder-token');
  const tools = await client.tools();
  expect(Object.keys(tools)).toEqual(['echo', 'second']);
  expect(
    await tools.echo.execute(
      {},
      { signal: new AbortController().signal, checkpoint: async () => {} },
    ),
  ).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  expect(seen.at(-1)?.headers.get('Mcp-Session-Id')).toBe('session');
  expect(seen.at(-1)?.headers.get('MCP-Protocol-Version')).toBe('2025-06-18');
});
