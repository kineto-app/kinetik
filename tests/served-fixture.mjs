/**
 * Models served through a sign-in connection: `GET /models` and a streaming
 * `POST /chat/completions` at `/api/kinetik/v1`, with the error answers a server may give.
 * `served.mode` scripts the answers; requests are recorded for assertions.
 */
export const servedRequests = [];
/** `absent` answers like a server without these models. */
export const served = { mode: 'absent' };
const prefix = '/api/kinetik/v1/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export async function servedFixture(req, res, body) {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/served/mode') {
    served.mode = url.searchParams.get('value') ?? 'absent';
    servedRequests.length = 0;
    res.writeHead(200, cors).end('{}');
    return true;
  }
  if (url.pathname === '/served/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(servedRequests));
    return true;
  }
  if (!url.pathname.startsWith(prefix)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return true;
  }
  const json = (status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...headers });
    res.end(JSON.stringify(value));
    return true;
  };
  const error = (status, code, headers) =>
    json(status, { error: { code, message: `Answer: ${code}` } }, headers);
  const auth = req.headers.authorization;
  const path = url.pathname.slice(prefix.length);
  if (served.mode === 'absent') {
    servedRequests.push({ path, auth });
    res.writeHead(404, cors).end();
    return true;
  }
  if (path === 'models' && req.method === 'GET') {
    servedRequests.push({ path, auth });
    if (served.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 3000));
    if (served.mode === 'off') return json(200, { data: [] });
    if (served.mode === 'disabled') return error(403, 'provider_disabled');
    if (served.mode === 'signed-in-only' && !auth) return error(401, 'invalid_token');
    if (served.mode === 'models-unauthorized') return error(401, 'invalid_token');
    return json(200, { data: [{ id: 'kinetik', name: 'Kinetik', effort: false }] });
  }
  if (path !== 'chat/completions' || req.method !== 'POST') return false;
  const request = JSON.parse(await body());
  servedRequests.push({ path, auth, body: request });
  if (!auth) return error(401, 'invalid_token');
  switch (served.mode) {
    case 'unauthorized':
      return error(401, 'invalid_token');
    case 'refused':
      return error(403, 'forbidden');
    case 'credits':
      return error(402, 'insufficient_credits');
    case 'disabled':
      return error(403, 'provider_disabled');
    case 'busy':
      return error(429, 'rate_limited', { 'Retry-After': '30' });
    case 'too-long':
      return error(400, 'context_length_exceeded');
    case 'upstream':
      return error(502, 'upstream_error');
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ...cors });
  if (served.mode === 'credits-mid-stream') {
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ error: { code: 'insufficient_credits', message: 'No credits' } })}\n\n`,
    );
    return true;
  }
  for (const content of ['Hello ', 'from ', 'Kinetik.'])
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 3 } })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
  return true;
}
