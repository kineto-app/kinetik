import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const base = 'http://127.0.0.1:4174';
const prefix = '/onboarding/';
let installRequired = false;
let browserChatGPT = false;
let modelRelay = false;
let failActivation = false;
let tokenExchanges = 0;
let failModel = false;
let modelRequests = 0;
let narratedModel = false;
let backgroundModel = false;
let streamModel = false;
let agentModel = false;
let overflowOnce = false;
export const agentRequests = [];
let finishStream;
let remoteRuns = 0;
let remoteDone = false;
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
    modelRelay = url.searchParams.has('relay');
    return reply({});
  }
  if (url.pathname === prefix + 'fail-activation') {
    failActivation = true;
    return reply({});
  }
  if (url.pathname === prefix + 'background-model') {
    backgroundModel = true;
    return reply({});
  }
  if (url.pathname === prefix + 'finish-job') {
    remoteDone = true;
    return reply({});
  }
  if (url.pathname === prefix + 'agent-model') {
    agentModel = true;
    agentRequests.length = 0;
    return reply({});
  }
  if (url.pathname === prefix + 'agent-requests') return reply(agentRequests);
  if (url.pathname === prefix + 'stream-model') {
    streamModel = true;
    return reply({});
  }
  if (url.pathname === prefix + 'finish-stream') {
    finishStream?.();
    return reply({});
  }
  if (url.pathname === prefix + 'narrated-model') {
    narratedModel = true;
    return reply({});
  }
  if (url.pathname === prefix + 'fail-model') {
    failModel = true;
    return reply({});
  }
  if (url.pathname === prefix + 'stats')
    return reply({ tokenExchanges, modelRequests, remoteRuns });
  if (url.pathname === prefix + 'reset') {
    failActivation = false;
    tokenExchanges = 0;
    modelRequests = 0;
    narratedModel = false;
    backgroundModel = false;
    streamModel = false;
    agentModel = false;
    overflowOnce = false;
    agentRequests.length = 0;
    finishStream?.();
    remoteRuns = 0;
    remoteDone = false;
    failModel = false;
    browserChatGPT = false;
    modelRelay = false;
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
        ? {
            mode: 'browser',
            jwksUrl: base + prefix + 'connections/chatgpt/keys',
            ...(modelRelay ? { modelRelay: base + prefix + 'connections/chatgpt/model/' } : {}),
          }
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
    tokenExchanges++;
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
    if (rpc.method === 'tools/list' && failActivation) {
      failActivation = false;
      return reply({ error: 'Temporary activation failure' }, 503);
    }
    let result = {};
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25' };
    if (rpc.method === 'tools/list')
      result = {
        tools: [
          ...(backgroundModel ? ['charms_job', 'charms_render'] : []),
          'charms_exec',
          'charms_files_read',
          'charms_files_write',
          'charms_files_edit',
          'charms_files_list',
          'charms_skill_find',
          'charms_skill_load',
        ].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
          ...(name === 'charms_render'
            ? { _meta: { ui: { resourceUri: 'ui://fixture/result' } } }
            : {}),
        })),
      };
    if (rpc.method === 'resources/read')
      result = {
        contents: [
          {
            uri: 'ui://fixture/result',
            mimeType: 'text/html;profile=mcp-app',
            text: `<p id="result">Loading</p><script>
        const send=(method,params,id)=>parent.postMessage({jsonrpc:'2.0',method,params,id},'*');
        addEventListener('message', e=>{if(e.data.id===1 && e.data.result) send('ui/notifications/initialized',{}); if(e.data.method==='ui/notifications/tool-result') document.getElementById('result').textContent='Recovered result';});
        send('ui/initialize',{},1);
      </script>`,
          },
        ],
      };
    if (rpc.method === 'tools/call') {
      let payload = { ok: true };
      if (backgroundModel && rpc.params.name === 'charms_exec') {
        remoteRuns++;
        payload = { job_id: 'durable-job', status: 'running' };
      }
      if (backgroundModel && rpc.params.name === 'charms_job')
        payload = {
          job_id: 'durable-job',
          status: remoteDone ? 'completed' : 'running',
          output: 'remote result',
        };
      if (rpc.params.name === 'charms_skill_find')
        payload = {
          catalog_version: '1',
          total_count: 1,
          charms: [
            { name: 'fixture-skill', description: 'A native fixture skill', charm_version: '1' },
          ],
        };
      result = { structuredContent: payload };
      if (rpc.params.name === 'charms_skill_load') {
        const metadata = { path: '/skills/fixture-skill' };
        result = {
          structuredContent: metadata,
          content: [
            { type: 'text', text: JSON.stringify(metadata) },
            { type: 'text', text: '# Fixture skill' },
          ],
        };
      }
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
    modelRequests++;
    if (failModel) {
      failModel = false;
      return reply({ error: 'Temporary model failure' }, 503);
    }
    if (agentModel) {
      const { request } = JSON.parse(await body());
      agentRequests.push(request);
      return agentReply(res, request);
    }
    if (streamModel) {
      await body();
      const event = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
      // Held open mid-reply, with an unclosed code fence, until the test finishes it.
      const partial =
        'Here is **the plan**:\n\n- Pack a bag\n- Book a train\n\n```js\nconst ready =';
      const text = partial + ' true;\n```';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(event({ type: 'response.output_text.delta', delta: partial }));
      await new Promise((resolve) => (finishStream = resolve));
      finishStream = undefined;
      res.end(
        event({ type: 'response.output_text.delta', delta: text.slice(partial.length) }) +
          event({
            type: 'response.completed',
            response: {
              output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
              ],
            },
          }),
      );
      return true;
    }
    if (backgroundModel) {
      const { request } = JSON.parse(await body());
      const step = modelRequests;
      const call = step === 1 ? 'background' : step === 3 ? 'charms__charms_render' : undefined;
      const output = call
        ? [
            {
              type: 'function_call',
              call_id: 'bg-call-' + step,
              name: request.tools[0].tools.find((tool) => tool.name.startsWith(call + '_')).name,
              arguments: JSON.stringify(
                step === 1
                  ? { action: 'start', tool: 'exec', input: { command: 'create result' } }
                  : { content: 'result' },
              ),
            },
          ]
        : [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: step === 2 ? 'Working in the background.' : 'Your result is ready.',
                },
              ],
            },
          ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n',
      );
      return true;
    }
    if (narratedModel) {
      const { request } = JSON.parse(await body());
      const step = request.input.filter((item) => item.type === 'function_call_output').length;
      const text = [
        'I will create the slides.',
        '',
        'The draft is ready. I will check it.',
        'The slides are ready.',
      ][step];
      const output = text
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
        : [];
      if (step < 3)
        output.push({
          type: 'function_call',
          call_id: 'fixture-call-' + step,
          name: request.tools[0].tools.find((tool) => tool.name.startsWith('exec_')).name,
          arguments: JSON.stringify({ command: 'echo step >> /workspace/actions' }),
        });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        (text
          ? 'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: text }) + '\n\n'
          : '') +
          'data: ' +
          JSON.stringify({ type: 'response.completed', response: { output } }) +
          '\n\n',
      );
      return true;
    }
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

/** Scripted agent for reliability proofs: usage, summaries, overflow and self-correction. */
function agentReply(res, request) {
  const event = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
  const users = request.input.filter((item) => item.role === 'user');
  const text = (item) =>
    Array.isArray(item?.content)
      ? item.content
          .filter((part) => part.type === 'input_text')
          .map((part) => part.text)
          .join('')
      : String(item?.content ?? '');
  const last = text(users.at(-1)).split('\n\nAttached files')[0];
  const images = Array.isArray(users.at(-1)?.content)
    ? users.at(-1).content.filter((part) => part.type === 'input_image').length
    : 0;
  // Only outputs after the latest user message belong to the current request.
  const turn = request.input.slice(request.input.lastIndexOf(users.at(-1)));
  const output = (id) =>
    turn.find((item) => item.type === 'function_call_output' && item.call_id === id)?.output;
  const calls = request.input.filter((item) => item.type === 'function_call_output');
  const tool = (prefix) =>
    request.tools[0]?.tools.find((t) => t.name.startsWith(prefix + '_'))?.name;
  const send = (
    output,
    usage = { input_tokens: 1200 + 400 * request.input.length, output_tokens: 60 },
  ) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = output.find((item) => item.type === 'message')?.content[0].text;
    res.end(
      (text ? event({ type: 'response.output_text.delta', delta: text }) : '') +
        event({ type: 'response.completed', response: { output, usage } }),
    );
    return true;
  };
  const say = (text, usage) =>
    send([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage);
  const call = (name, args, id) =>
    send([
      { type: 'function_call', call_id: id, name: tool(name), arguments: JSON.stringify(args) },
    ]);
  /** Streams a reply word by word, optionally after a reasoning summary. */
  const streamSay = async (text, reasoning = '') => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
    for (const delta of reasoning.match(/\S+\s*/g) ?? []) {
      res.write(event({ type: 'response.reasoning_summary_text.delta', delta }));
      await pause();
    }
    for (const delta of text.match(/\S+\s*/g)) {
      res.write(event({ type: 'response.output_text.delta', delta }));
      await pause();
    }
    res.end(
      event({
        type: 'response.completed',
        response: {
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
          ],
          usage: { input_tokens: 2400, output_tokens: 90 },
        },
      }),
    );
    return true;
  };
  if (last === 'Plan the carousel')
    return streamSay(
      'Here is the plan: a calm Lisbon cover, then one slide per day, ending with a packing tip.',
      '**Planning the carousel**\n\nThe user wants a Lisbon carousel. I will start with a calm cover photo, then give each day its own slide so the story reads in order.\n\n**Choosing the ending**\n\nA short packing tip makes a useful last slide that people save.',
    );
  if (last === 'Build the slides') {
    if (!output('slide-1'))
      return call('write', { path: '/workspace/slide-1.md', content: '# Lisbon' }, 'slide-1');
    if (!output('slide-2'))
      return call('write', { path: '/workspace/slide-2.md', content: '# Day two' }, 'slide-2');
    if (!output('slide-3')) return call('exec', { command: 'sleep 4; echo rendered' }, 'slide-3');
    return streamSay(
      'Your three slides are ready: a Lisbon cover, a day-two plan and a rendered preview. Open the files panel to see them, or ask me to change the style.',
    );
  }
  if (last.startsWith('Summarise the conversation so far'))
    return say(
      'The user is planning a Lisbon trip, prefers short answers, and saved notes in /workspace/trip.md.',
    );
  if (last === 'Fill the context')
    return say('Noted. That was a long document.', { input_tokens: 170000, output_tokens: 80 });
  if (last === 'Overflow now' && !overflowOnce) {
    overflowOnce = true;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'context_length_exceeded', message: 'Input exceeds the context window.' },
      }),
    );
    return true;
  }
  if (images)
    return say(
      `I can see ${images} photo${images > 1 ? 's' : ''}. I will use them for the carousel.`,
    );
  if (last === 'Pick a style')
    return output('ask-1')
      ? say(
          `Great — ${output('ask-1').replace('The user chose: ', '')} it is. Building the carousel now.`,
        )
      : call(
          'ask',
          {
            question: 'Which style should the carousel use?',
            options: ['Bold', 'Calm', 'Playful'],
          },
          'ask-1',
        );
  if (last === 'Remember I write in Russian')
    return output('mem-1')
      ? say('Got it. I will keep that in mind in every chat.')
      : call('remember', { text: 'Writes in Russian. Prefers short answers.' }, 'mem-1');
  if (last === 'Publish my post')
    return output('pub-1')
      ? say(
          output('pub-1').startsWith('The user declined')
            ? 'Okay, I did not publish it.'
            : 'Published your post.',
        )
      : call('mcp__publish', { title: 'Three days in Lisbon' }, 'pub-1');
  if (last === 'Slow task')
    return output('slow-1')
      ? say('Slow task finished.')
      : call('exec', { command: 'sleep 3; echo built' }, 'slow-1');
  if (last === 'Then send me a summary') return say('Here is the summary you queued: all done.');
  if (last === 'Save my trip note') {
    if (calls.length === 0) return call('write', { path: 42 }, 'fix-1');
    if (calls.length === 1) return call('read', { path: '/workspace/missing.md' }, 'fix-2');
    if (calls.length === 2)
      return call('write', { path: '/workspace/trip.md', content: 'Lisbon, 3 days' }, 'fix-3');
    return say(
      'Saved your trip note to trip.md. I fixed a wrong argument and skipped a missing file along the way.',
    );
  }
  const summarised = String(users[0]?.content ?? '').startsWith(
    'Summary of the earlier conversation',
  );
  return say(
    users.length > 2 || summarised
      ? `Here is answer ${users.length}. I still remember your earlier requests${summarised ? ' from the summary' : ''}.`
      : 'Happy to help. What would you like to plan?',
  );
}
