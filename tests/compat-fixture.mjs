/**
 * A minimal OpenAI-compatible Chat Completions endpoint that streams the real SSE wire format,
 * scripted by the latest user text. Requests are recorded for assertions.
 */
export const compatRequests = [];

const cors = { 'Access-Control-Allow-Origin': '*' };
const chunk = (delta, extra = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: 'fixture-model',
  choices: [{ index: 0, delta, finish_reason: null, ...extra }],
});

async function stream(res, chunks, pause = 80) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ...cors });
  for (const value of chunks) {
    res.write(`data: ${JSON.stringify(value)}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  res.end('data: [DONE]\n\n');
}
const words = (text) => text.match(/\S+\s*/g);
const usage = (prompt) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [],
  usage: {
    prompt_tokens: prompt,
    completion_tokens: 25,
    prompt_tokens_details: { cached_tokens: 100 },
  },
});

function reply(res, body) {
  const messages = body.messages;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = (
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('')
  ).split('\n\nAttached files')[0];
  const answered = messages.at(-1)?.role === 'tool';
  const list = body.tools?.find((t) => t.function.name.startsWith('list_'))?.function.name;
  if (text === 'Too long') {
    res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
    res.end(
      JSON.stringify({
        error: {
          message: "This model's maximum context length is 8192 tokens.",
          code: 'context_length_exceeded',
        },
      }),
    );
    return;
  }
  if (text === 'Custom, list my files' && !answered)
    return stream(res, [
      chunk({ role: 'assistant', content: null }),
      chunk({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: list, arguments: '' } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"/workspace"}' } }] }),
      chunk({}, { finish_reason: 'tool_calls' }),
      usage(2100),
    ]);
  const answer = answered
    ? 'The custom model looked at your workspace.'
    : 'Hello from the custom model. How can I help with your carousel?';
  return stream(res, [
    chunk({ role: 'assistant', content: '' }),
    ...(answered
      ? []
      : words('The user greets me, so a short answer fits.').map((w) =>
          chunk({ reasoning_content: w }),
        )),
    ...words(answer).map((w) => chunk({ content: w })),
    chunk({}, { finish_reason: 'stop' }),
    usage(1800),
  ]);
}

/** Handles a Chat Completions request; returns false when the path is not this fixture. */
export async function compatFixture(req, res, readBody) {
  const url = new URL(req.url, 'http://fixture');
  if (!url.pathname.startsWith('/compat/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'POST',
    });
    res.end();
    return true;
  }
  if (url.pathname === '/compat/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(compatRequests));
    return true;
  }
  if (url.pathname === '/compat/reset') {
    compatRequests.length = 0;
    res.writeHead(200).end('{}');
    return true;
  }
  if (url.pathname === '/compat/v1/chat/completions') {
    const body = JSON.parse(await readBody());
    compatRequests.push({ authorization: req.headers.authorization, body });
    if (req.headers.authorization !== 'Bearer compat-test-key') {
      res.writeHead(401, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return true;
    }
    await reply(res, body);
    return true;
  }
  return false;
}
