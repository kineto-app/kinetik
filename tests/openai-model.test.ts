import { expect, test, vi } from 'vitest';
import { OpenAIModel, readResponse } from '../src/core/openai-model';
const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
test('a usage failure after streamed text is a failed request', async () => {
  const onText = vi.fn();
  await expect(
    readResponse(
      new Response(
        event({ type: 'response.output_text.delta', delta: 'partial' }) +
          event({
            type: 'response.failed',
            response: { error: { message: 'Usage limit reached' } },
          }),
      ),
      onText,
    ),
  ).rejects.toThrow('Usage limit reached');
  expect(onText).toHaveBeenCalledWith('partial');
});
test('an interrupted stream cannot be accepted as completion', async () => {
  await expect(
    readResponse(new Response(event({ type: 'response.output_text.delta', delta: 'partial' }))),
  ).rejects.toThrow('interrupted');
});
test('model request uses subscription route requirements and maps real tool calls', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    expect(body.request.store).toBe(false);
    expect(body.request.stream).toBe(true);
    expect(body.request.previous_response_id).toBeUndefined();
    expect(body.request.tools[0].type).toBe('namespace');
    return new Response(
      event({
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'function_call',
              name: body.request.tools[0].tools[0].name,
              call_id: 'call-1',
              arguments: '{"path":"/workspace/note"}',
            },
          ],
        },
      }),
    );
  });
  try {
    const model = new OpenAIModel('https://local.test/api/responses', async () => ({
      account: 'account',
      model: 'available-model',
    }));
    const result = await model.next(
      {
        message: 'read note',
        instructions: 'test',
        tools: ['read'],
        definitions: { read: { description: 'Read', inputSchema: { type: 'object' } } },
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      type: 'tool',
      name: 'read',
      callId: 'call-1',
      input: { path: '/workspace/note' },
    });
  } finally {
    fetcher.mockRestore();
  }
});
