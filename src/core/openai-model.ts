import type { Model, ModelRequest, ModelStep, Usage } from './types';
import { ConnectionError, ContextOverflow, SignInRequired } from './connection-error';

export async function toolName(name: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
  const suffix = [...new Uint8Array(bytes)]
    .slice(0, 10)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) + '_' + suffix;
}
/** OpenAI-compatible streaming response parser. Success requires the terminal event. */
export const overflow = (code: unknown, text: unknown) =>
  code === 'context_length_exceeded' ||
  /context (window|length)|maximum context|too many (input )?tokens/i.test(String(text ?? ''));
export async function readResponse(
  response: Response,
  onText?: (text: string) => void,
  meta: { usage?: Usage } = {},
  onReasoning?: (text: string) => void,
): Promise<Record<string, unknown>[]> {
  if (!response.ok) {
    if ([401, 403].includes(response.status))
      throw new SignInRequired('Reconnect ChatGPT to continue.');
    if ([408, 429, 500, 502, 503, 504].includes(response.status))
      throw new ConnectionError('The model connection was interrupted.');
    const error = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    const text = error.error?.message ?? `Model request failed: HTTP ${response.status}`;
    if (overflow(error.error?.code, error.error?.message)) throw new ContextOverflow(text);
    throw new Error(text);
  }
  if (!response.body) throw new Error('Model returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const started = new Set<number>();
  const finished = new Map<number, Record<string, unknown>>();
  let buffer = '',
    text = '',
    reasoning = '',
    size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      size += value?.length ?? 0;
      if (size > 16 * 1024 * 1024) throw new Error('Model response exceeded 16 MiB.');
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (
          event.type === 'response.output_item.added' ||
          event.type === 'response.output_item.done'
        ) {
          if (
            !Number.isSafeInteger(event.output_index) ||
            event.output_index < 0 ||
            !event.item ||
            typeof event.item !== 'object'
          )
            throw new Error('Invalid streamed output item.');
          started.add(event.output_index);
          if (event.type === 'response.output_item.done')
            finished.set(event.output_index, event.item);
        }
        if (event.type === 'response.reasoning_summary_part.added' && reasoning)
          reasoning += '\n\n';
        if (event.type === 'response.reasoning_summary_text.delta') {
          reasoning += event.delta;
          onReasoning?.(reasoning);
        }
        if (event.type === 'response.output_text.delta') {
          text += event.delta;
          onText?.(text);
        }
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          const failure = event.response?.error ?? event.error ?? event;
          const text = failure.message ?? 'Model response did not complete.';
          if (
            overflow(failure.code, failure.message) ||
            event.response?.incomplete_details?.reason === 'max_output_tokens'
          )
            throw new ContextOverflow(text);
          throw new Error(text);
        }
        if (event.type === 'response.completed') {
          const usage = event.response?.usage;
          if (usage && Number.isFinite(usage.input_tokens))
            meta.usage = {
              input: usage.input_tokens,
              output: Number(usage.output_tokens) || 0,
              cached: Number(usage.input_tokens_details?.cached_tokens) || undefined,
            };
          if (!Array.isArray(event.response?.output))
            throw new Error('Model completed without output.');
          if (event.response.output.length) return event.response.output;
          // SIWC streams can carry complete items only in output_item.done,
          // leaving the terminal response's output array empty.
          if (!finished.size || [...started].some((index) => !finished.has(index)))
            throw new Error('Model completed without all streamed output items.');
          return [...finished.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
        }
      }
      if (done) throw new ConnectionError('Model stream interrupted before completion.');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Models without image input get a note in place of each photo instead of a rejected request. */
export function withoutImages(history: Record<string, unknown>[] | undefined) {
  return history?.map((item) =>
    Array.isArray(item.content)
      ? {
          ...item,
          content: item.content.map((part: { type?: string }) =>
            part.type === 'input_image'
              ? {
                  type: 'input_text',
                  text: '[A photo is attached, but this model cannot view images.]',
                }
              : part,
          ),
        }
      : item,
  );
}

/**
 * Every request resends the whole history, and the relay caps a body at 8 MB. Only the newest
 * photos within this budget go as images; older ones become a note, and the model keeps their paths.
 */
const imageBudget = { count: 8, bytes: 4 * 1024 * 1024 };
export function latestImages(history: Record<string, unknown>[] | undefined) {
  let count = 0;
  let bytes = 0;
  const keep = new Set<unknown>();
  for (const item of [...(history ?? [])].reverse())
    for (const part of [...(Array.isArray(item.content) ? item.content : [])].reverse()) {
      if (part?.type !== 'input_image') continue;
      const size = String(part.image_url ?? '').length;
      if (count < imageBudget.count && bytes + size <= imageBudget.bytes) keep.add(part);
      count++;
      bytes += size;
    }
  if (keep.size === count) return history;
  return history?.map((item) =>
    Array.isArray(item.content)
      ? {
          ...item,
          content: item.content.map((part: { type?: string }) =>
            part.type === 'input_image' && !keep.has(part)
              ? {
                  type: 'input_text',
                  text: '[An earlier photo is no longer shown to keep the request small. Its file path is listed in this message.]',
                }
              : part,
          ),
        }
      : item,
  );
}

export class OpenAIModel implements Model {
  constructor(
    private endpoint: string,
    private configuration: () => Promise<{
      account: string;
      model: string;
      contextWindow?: number;
      images?: boolean;
    }>,
    private request: typeof fetch = fetch.bind(globalThis),
    private compactor?: (
      account: string,
      input: Record<string, unknown>[],
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>[]>,
  ) {}
  async compact(input: Record<string, unknown>[], _pin: string | undefined, signal: AbortSignal) {
    if (!this.compactor) return undefined;
    const config = await this.configuration();
    return this.compactor(config.account, input, signal);
  }
  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    const config = await this.configuration();
    if (!config.account || !config.model)
      throw new SignInRequired('Connect ChatGPT and choose a model in Account.');
    const names = new Map<string, string>();
    const tools = await Promise.all(
      Object.entries(request.definitions ?? {}).map(async ([name, definition]) => {
        const encoded = await toolName(name);
        names.set(encoded, name);
        return {
          type: 'function',
          name: encoded,
          description: definition.description,
          parameters: definition.inputSchema,
          strict: false,
        };
      }),
    );
    const response = await this.request(this.endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: { 'Content-Type': 'application/json', 'X-Kinetik-Request': '1' },
      body: JSON.stringify({
        account: config.account,
        request: {
          model: config.model,
          instructions: request.instructions,
          input:
            config.images === false
              ? withoutImages(request.history)
              : (latestImages(request.history) ?? [{ role: 'user', content: request.message }]),
          tools: tools.length
            ? [{ type: 'namespace', name: 'kinetik', description: 'Kinetik agent tools', tools }]
            : [],
          parallel_tool_calls: true,
          include: ['reasoning.encrypted_content'],
          store: false,
          stream: true,
        },
      }),
    });
    const meta: { usage?: Usage } = {};
    const items = await readResponse(response, request.onText, meta, request.onReasoning);
    const extra = { usage: meta.usage, contextWindow: config.contextWindow };
    const text = items
      .filter((item) => item.type === 'message')
      .flatMap((item) => (item.content ?? []) as { text?: string }[])
      .map((part) => part.text ?? '')
      .join('');
    const calls = items.filter((item) => item.type === 'function_call');
    const decode = (call: Record<string, unknown>) => {
      const name = names.get(String(call.name));
      if (!name || typeof call.call_id !== 'string' || typeof call.arguments !== 'string')
        throw new Error('Model returned an unknown tool call.');
      const input = JSON.parse(call.arguments);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid tool arguments.');
      return { name, input, callId: call.call_id };
    };
    if (calls.length > 1)
      return {
        type: 'tools',
        calls: calls.map(decode),
        narration: text || undefined,
        items,
        ...extra,
      };
    if (calls.length) {
      const call = calls[0];
      const name = names.get(String(call.name));
      if (!name || typeof call.call_id !== 'string' || typeof call.arguments !== 'string')
        throw new Error('Model returned an unknown tool call.');
      const input = JSON.parse(call.arguments);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid tool arguments.');
      return {
        type: 'tool',
        name,
        input,
        callId: call.call_id,
        narration: text || undefined,
        items,
        ...extra,
      };
    }
    if (!text) throw new Error('Model completed without a message or tool call.');
    return { type: 'text', text, items, ...extra };
  }
}
