import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { renderConnectPage } from '../bin/connect-page.mjs';
import { onboardingFixture } from './onboarding-fixture.mjs';
let revision = 1,
  fail = false;
const manifest = {
  id: 'fixture',
  name: 'Fixture plugin',
  version: '1.0.0',
  apiVersion: 1,
  entry: 'plugin.js',
};
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, mcp-protocol-version, mcp-session-id',
  );
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.end();
  if (await onboardingFixture(req, res)) return;
  if (req.url === '/connect') {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
    );
    return res.end(
      await renderConnectPage({
        appStyles: '/styles.css',
        themeScript: '/theme.js',
        uiBase: '/ui/',
        apiBase: '/account/',
        appUrl: '/workspace',
      }),
    );
  }
  const connectAssets = {
    '/ui/connect.js': ['../bin/ui/connect.js', 'text/javascript'],
    '/ui/connect.css': ['../bin/ui/connect.css', 'text/css'],
    '/styles.css': ['../src/ui/styles.css', 'text/css'],
    '/tokens.css': ['../src/ui/tokens.css', 'text/css'],
    '/theme.js': ['../public/theme.js', 'text/javascript'],
  };
  if (connectAssets[req.url]) {
    const [file, type] = connectAssets[req.url];
    res.setHeader('Content-Type', type);
    return res.end(await readFile(new URL(file, import.meta.url)));
  }

  if (req.url === '/mcp') {
    let data = '';
    for await (const part of req) data += part;
    const rpc = JSON.parse(data);
    let result = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'show',
            description: 'Show interactive app',
            inputSchema: { type: 'object' },
            _meta: { ui: { resourceUri: 'ui://fixture/view' } },
          },
          {
            name: 'increment',
            description: 'App-only increment',
            inputSchema: { type: 'object' },
            _meta: { ui: { visibility: ['app'] } },
          },
          {
            name: 'publish',
            description: 'Publish a post',
            inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
            annotations: { destructiveHint: true },
          },
          {
            name: 'secret',
            description: 'Model only',
            inputSchema: { type: 'object' },
            _meta: { ui: { visibility: ['model'] } },
          },
        ],
      };
    if (rpc.method === 'resources/read')
      result = {
        contents: [
          {
            uri: 'ui://fixture/view',
            mimeType: 'text/html;profile=mcp-app',
            text: `<!doctype html><html><style>
        body { color:var(--color-text-primary); font-family:var(--font-sans); }
        #surface { background:var(--color-background-primary); border:1px solid var(--color-border-primary); border-radius:var(--border-radius-lg); }
      </style><body><div id="surface">Host styles</div><p id="result">Loading</p><p id="isolation"></p><button id="inc">Increment</button><button id="denied">Forbidden tool</button><button id="expand">Full screen</button><button id="collapse">Back to chat</button><button id="pip">Picture in picture</button><p id="mode"></p><p id="mode-result"></p><input aria-label="Widget note" /><section id="detail" hidden>Full screen detail view</section><script>
      try { top.localStorage.setItem('escaped','true'); document.getElementById('isolation').textContent='Unsafe'; } catch { document.getElementById('isolation').textContent='Isolated'; }
      const send = (method, params, id) => parent.postMessage({jsonrpc:'2.0',method,params,id}, '*');
      addEventListener('message', event => {
        const data=event.data;
        const ctx = data.id === 1 ? data.result?.hostContext : data.method === 'ui/notifications/host-context-changed' ? data.params : null;
        if (ctx) {
          window.hostContext = { ...window.hostContext, ...ctx };
          if(ctx.displayMode) {
            document.getElementById('mode').textContent=ctx.displayMode;
            document.getElementById('detail').hidden=ctx.displayMode!=='fullscreen';
          }
          document.documentElement.style.colorScheme = ctx.theme;
          for (const [key,value] of Object.entries(ctx.styles?.variables ?? {})) document.documentElement.style.setProperty(key,value);
        }
        if(data.id === 1 && data.result) send('ui/notifications/initialized', {});
        if(data.method === 'ui/notifications/tool-result') document.getElementById('result').textContent='Ready';
        if(data.id === 2) document.getElementById('result').textContent=data.result ? 'Incremented' : 'Failed';
        if(data.id === 3) document.getElementById('result').textContent=data.error ? 'Denied' : 'Unsafe';
        if(data.id === 4) document.getElementById('mode-result').textContent=data.result.mode;
      });
      document.getElementById('inc').onclick=()=>send('tools/call',{name:'increment',arguments:{}},2);
      document.getElementById('denied').onclick=()=>send('tools/call',{name:'secret',arguments:{}},3);
      document.getElementById('expand').onclick=()=>send('ui/request-display-mode',{mode:'fullscreen'},4);
      document.getElementById('collapse').onclick=()=>send('ui/request-display-mode',{mode:'inline'},4);
      document.getElementById('pip').onclick=()=>send('ui/request-display-mode',{mode:'pip'},4);
      send('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'fixture',version:'1'},appCapabilities:{}},1);
    <\/script></body></html>`,
          },
        ],
      };
    if (rpc.method === 'tools/call')
      result = {
        content: [
          { type: 'text', text: rpc.params.name === 'increment' ? 'Incremented' : 'App result' },
        ],
      };
    if (rpc.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  }
  if (req.url === '/control') {
    let data = '';
    for await (const part of req) data += part;
    const state = JSON.parse(data);
    revision = state.revision ?? revision;
    fail = state.fail ?? fail;
    return res.end('ok');
  }
  if (req.url === '/plugin.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ...manifest, version: `${revision}.0.0` }));
  }
  if (req.url === '/plugin.js') {
    res.setHeader('Content-Type', 'text/plain');
    return res.end(
      `return { tools:{echo:{description:'Fixture execution',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false},async execute({command}){return 'code-${revision}: '+command;}}},replacements:{exec:'echo'},skills:{async sync(previous,signal){const r=await fetch(new URL('skills.json',host.baseURL),{signal,cache:'no-store'});if(!r.ok)throw new Error('Skill source offline');return await r.json();}}};`,
    );
  }
  if (req.url === '/skills.json') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = fail ? 503 : 200;
    return res.end(
      JSON.stringify({
        revision: String(revision),
        skills: [
          {
            name: 'fixture-skill',
            description: `Description ${revision}`,
            path: 'fixture/SKILL.md',
            content: `# Revision ${revision}`,
          },
        ],
      }),
    );
  }
  res.end('ok');
});
server.listen(4174, '127.0.0.1');
