import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const base = 'http://127.0.0.1:4174';
const prefix = '/onboarding/';
let installRequired = false;
let browserChatGPT = false;
let connected = false,
  revoked = false;
const flows = new Map();
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export async function onboardingFixture(req, res) {
  const url = new URL(req.url, base);
  if (!url.pathname.startsWith(prefix) && !url.pathname.startsWith('/fixture-oauth/')) return false;
  const reply = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
    return true;
  };
  const body = async () => {
    let text = '';
    for await (const part of req) text += part;
    return text;
  };
  if (url.pathname === prefix + 'require-install') {
    installRequired = true;
    return reply({});
  }
  if (url.pathname === prefix + 'browser-chatgpt') {
    browserChatGPT = true;
    return reply({});
  }
  if (url.pathname === prefix + 'reset') {
    browserChatGPT = false;
    installRequired = false;
    connected = false;
    revoked = false;
    flows.clear();
    return reply({});
  }
  if (url.pathname === prefix + 'expire') {
    revoked = true;
    return reply({});
  }
  if (url.pathname === prefix + 'config.json')
    return reply({
      installation: { required: installRequired },
      connections: {
        charms: {
          url: base + prefix + 'connections/charms/mcp',
          resource: base + '/resource',
          issuer: base + '/fixture-oauth',
          metadataUrl: base + prefix + 'connections/charms/metadata',
        },
      },
      chatgpt: browserChatGPT
        ? { mode: 'browser', jwksUrl: base + prefix + 'connections/chatgpt/keys' }
        : { apiBase: base + prefix + 'connections/chatgpt/' },
    });
  if (url.pathname === prefix + 'connections/charms/metadata')
    return reply({
      issuer: base + '/fixture-oauth',
      authorization_endpoint: base + '/fixture-oauth/authorize',
      registration_endpoint: base + prefix + 'connections/charms/register',
      token_endpoint: base + prefix + 'connections/charms/token',
      revocation_endpoint: base + prefix + 'connections/charms/revoke',
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  if (url.pathname.endsWith('/register')) return reply({ client_id: 'browser-client' });
  if (url.pathname === '/fixture-oauth/authorize') {
    const code = randomUUID();
    flows.set(code, Object.fromEntries(url.searchParams));
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<h1>Authorize Charms fixture</h1><a href="${callback.href.replaceAll('&', '&amp;')}">Allow Charms</a>`,
    );
    return true;
  }
  if (url.pathname.endsWith('/token')) {
    const values = new URLSearchParams(await body());
    const flow = flows.get(values.get('code'));
    flows.delete(values.get('code'));
    const challenge = createHash('sha256')
      .update(values.get('code_verifier') || '')
      .digest('base64url');
    if (
      !flow ||
      challenge !== flow.code_challenge ||
      values.get('redirect_uri') !== flow.redirect_uri ||
      values.get('resource') !== flow.resource
    )
      return reply({ error: 'invalid_grant' }, 400);
    revoked = false;
    return reply({ access_token: 'charms-fixture-token', token_type: 'Bearer' });
  }
  if (url.pathname.endsWith('/revoke')) {
    revoked = true;
    return reply({});
  }
  if (url.pathname.endsWith('/mcp')) {
    if (revoked || req.headers.authorization !== 'Bearer charms-fixture-token')
      return reply({}, 401);
    const rpc = JSON.parse(await body());
    let result = {};
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25' };
    if (rpc.method === 'tools/list')
      result = {
        tools: [
          'charms_exec',
          'charms_files_read',
          'charms_files_write',
          'charms_files_edit',
          'charms_files_list',
          'charms_skill_find',
          'charms_skill_load',
        ].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
      };
    if (rpc.method === 'tools/call') {
      let payload = { ok: true };
      if (rpc.params.name === 'charms_skill_find')
        payload = {
          catalog_version: '1',
          total_count: 1,
          charms: [
            { name: 'fixture-skill', description: 'A native fixture skill', charm_version: '1' },
          ],
        };
      if (rpc.params.name === 'charms_skill_load')
        payload = { skill_md: '# Fixture skill', path: '/skills/fixture-skill' };
      result = { structuredContent: payload };
    }
    if (rpc.id === undefined) {
      res.writeHead(202);
      res.end();
      return true;
    }
    return reply({ jsonrpc: '2.0', id: rpc.id, result });
  }
  if (url.pathname.endsWith('/chatgpt/status')) return reply({ connected, model: 'fixture-model' });
  if (url.pathname.endsWith('/chatgpt/logout')) {
    connected = false;
    return reply({});
  }
  if (url.pathname.endsWith('/chatgpt/login'))
    return reply({ url: 'https://auth.openai.com/authorize?fixture=1' });
  if (url.pathname.endsWith('/chatgpt/callback')) {
    await body();
    connected = true;
    return reply({});
  }
  if (url.pathname.endsWith('/chatgpt/responses')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Your Charms workspace is ready.' }],
              },
            ],
          },
        }) +
        '\n\n',
    );
    return true;
  }
  const root = resolve('dist');
  const file = resolve(root, url.pathname.slice(prefix.length) || 'index.html');
  if (!file.startsWith(root + sep)) return reply({}, 404);
  try {
    const contents = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'text/plain' });
    res.end(contents);
  } catch {
    return reply({}, 404);
  }
  return true;
}
