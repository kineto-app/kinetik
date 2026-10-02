/**
 * Minimal Anthropic Messages and Gemini streamGenerateContent endpoints that speak the real
 * SSE wire formats, scripted by the latest user text. Requests are recorded for assertions.
 */
export const providerRequests = [];

const sse = (res, events, pause = 0) => {
  // Thinking streams slower than text, so it stays on screen long enough to see.
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
  const send = async () => {
    for (const [name, data] of events) {
      res.write((name ? `event: ${name}\n` : '') + `data: ${JSON.stringify(data)}\n\n`);
      const slow = data?.delta?.type === 'thinking_delta' ? 3 : 1;
      if (pause) await new Promise((resolve) => setTimeout(resolve, pause * slow));
    }
    res.end();
  };
  return send();
};

function lastUserText(messages, read) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = read(messages[i]);
    if (text !== undefined) return text.split('\n\nAttached files')[0];
  }
  return '';
}

function anthropic(req, res, body) {
  if (req.headers['x-api-key'] !== 'sk-ant-test-key-123') {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    );
    return;
  }
  const last = lastUserText(body.messages, (m) =>
    m.role !== 'user'
      ? undefined
      : typeof m.content === 'string'
        ? m.content
        : m.content.some((p) => p.type === 'tool_result')
          ? undefined
          : m.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join(''),
  );
  const turns = body.messages.filter((m) => m.role !== 'system');
  const toolResult = turns.at(-1)?.content?.find?.((p) => p.type === 'tool_result');
  const tool = body.tools?.find((t) => t.name.startsWith('list_'));
  const start = [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_' + providerRequests.length,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1800, output_tokens: 1, cache_read_input_tokens: 200 },
      },
    },
  ];
  const thinking = (index, text) => [
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    ],
    ...text
      .match(/\S+\s*/g)
      .map((word) => [
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: word } },
      ]),
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: 'sig-claude-1' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index }],
  ];
  const text = (index, value) => [
    [
      'content_block_start',
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ],
    ...value
      .match(/\S+\s*/g)
      .map((word) => [
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } },
      ]),
    ['content_block_stop', { type: 'content_block_stop', index }],
  ];
  const end = (reason) => [
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: 42 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  if (last === 'Claude, list my files' && !toolResult)
    return sse(
      res,
      [
        start,
        ...thinking(0, 'I should look at the workspace first.'),
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_1', name: tool.name, input: {} },
          },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/workspace"}' },
          },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ...end('tool_use'),
      ],
      60,
    );
  if (toolResult)
    return sse(
      res,
      [start, ...text(0, 'Claude looked at your workspace and it is ready.'), ...end('end_turn')],
      60,
    );
  return sse(
    res,
    [
      start,
      ...thinking(0, 'The user greets me. A short friendly answer fits.'),
      ...text(1, 'Hello from Claude. How can I help with your carousel?'),
      ...end('end_turn'),
    ],
    90,
  );
}

function gemini(req, res, body) {
  if (req.headers['x-goog-api-key'] !== 'gemini-test-key-123') {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(
      JSON.stringify({
        error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' },
      }),
    );
    return;
  }
  const contents = body.contents ?? [];
  const last = lastUserText(contents, (c) =>
    c.role !== 'user' || c.parts.some((p) => p.functionResponse)
      ? undefined
      : c.parts.map((p) => p.text ?? '').join(''),
  );
  const answered = contents.at(-1)?.parts?.some((p) => p.functionResponse);
  const tool = body.tools?.[0]?.functionDeclarations?.find((t) => t.name.startsWith('list_'));
  const usage = { promptTokenCount: 1500, candidatesTokenCount: 30, totalTokenCount: 1530 };
  const chunk = (parts, finishReason) => [
    '',
    {
      candidates: [
        { content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}), index: 0 },
      ],
      usageMetadata: usage,
    },
  ];
  if (last === 'Gemini, list my files' && !answered)
    return sse(res, [
      chunk(
        [
          {
            functionCall: { name: tool.name, args: { path: '/workspace' } },
            thoughtSignature: 'c2lnLWdlbWluaS0x',
          },
        ],
        'STOP',
      ),
    ]);
  const reply = answered ? 'Gemini checked your workspace.' : 'Hello from Gemini.';
  return sse(
    res,
    [
      ...reply.match(/\S+\s*/g).map((word) => chunk([{ text: word }])),
      chunk([{ text: '' }], 'STOP'),
    ],
    60,
  );
}

/** Handles a provider request; returns false when the path is not a provider endpoint. */
export async function providerFixture(req, res, readBody) {
  const url = new URL(req.url, 'http://fixture');
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/providers/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST',
    });
    res.end();
    return true;
  }
  if (url.pathname === '/providers/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(providerRequests));
    return true;
  }
  if (url.pathname === '/providers/reset') {
    providerRequests.length = 0;
    res.writeHead(200).end('{}');
    return true;
  }
  if (url.pathname === '/providers/anthropic/v1/messages') {
    const body = JSON.parse(await readBody());
    providerRequests.push({ provider: 'anthropic', path: url.pathname, body });
    await anthropic(req, res, body);
    return true;
  }
  if (
    url.pathname.startsWith('/providers/google/') &&
    url.pathname.includes(':streamGenerateContent')
  ) {
    const body = JSON.parse(await readBody());
    providerRequests.push({ provider: 'google', path: url.pathname, body });
    await gemini(req, res, body);
    return true;
  }
  return false;
}
