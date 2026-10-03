import { ConnectionError, ContextOverflow, SignInRequired } from '../core/connection-error';
import { latestImages, overflow, toolName, withoutImages } from './openai';
import type { Model, ModelRequest, ModelStep, Usage } from '../core/types';
import type { CustomModel } from '../connections/custom-model';

type Item = Record<string, unknown>;
type ChatMessage = Record<string, unknown>;
const keyProblem = 'Check the custom model’s API key in Settings → ChatGPT → Advanced.';

function userContent(content: unknown, images: boolean): string | Record<string, unknown>[] {
  if (!Array.isArray(content)) return String(content ?? '');
  const parts: Record<string, unknown>[] = [];
  for (const part of content as { type?: string; text?: string; image_url?: string }[]) {
    if (part.type === 'input_text') parts.push({ type: 'text', text: part.text ?? '' });
    else if (part.type === 'input_image' && images)
      parts.push({ type: 'image_url', image_url: { url: part.image_url } });
  }
  return parts;
}

/**
 * Kinetik stores model input in the Responses format. This reads it as Chat Completions
 * messages. Items only OpenAI can read (encrypted reasoning, compaction) are left out.
 */
export function toChatMessages(instructions: string, history: Item[], images = true) {
  const messages: ChatMessage[] = [{ role: 'system', content: instructions }];
  let assistant: { role: 'assistant'; content: string | null; tool_calls?: unknown[] } | undefined;
  const flush = () => {
    if (assistant) messages.push(assistant);
    assistant = undefined;
  };
  const open = () => (assistant ??= { role: 'assistant', content: null });
  for (const item of history) {
    if (item.role === 'user' && item.type === undefined) {
      flush();
      messages.push({ role: 'user', content: userContent(item.content, images) });
    } else if (item.type === 'message' && item.role === 'assistant') {
      const text = ((item.content ?? []) as { text?: string }[]).map((p) => p.text ?? '').join('');
      if (text) open().content = (assistant!.content ?? '') + text;
    } else if (item.type === 'function_call') {
      (open().tool_calls ??= []).push({
        id: String(item.call_id),
        type: 'function',
        function: { name: String(item.name), arguments: String(item.arguments ?? '{}') },
      });
    } else if (item.type === 'function_call_output') {
      flush();
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id),
        content: String(item.output ?? ''),
      });
    }
  }
  flush();
  return messages;
}

/** Any OpenAI-compatible server through its Chat Completions endpoint, with the user's own key. */
export class CompatModel implements Model {
  constructor(
    private configuration: () => Promise<CustomModel | undefined>,
    private request: typeof fetch = fetch.bind(globalThis),
  ) {}
  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    const config = await this.configuration();
    if (!config)
      throw new SignInRequired('Set up the custom model in Settings → ChatGPT → Advanced.');
    const names = new Map<string, string>();
    const tools = await Promise.all(
      Object.entries(request.definitions ?? {}).map(async ([name, definition]) => {
        const encoded = await toolName(name);
        names.set(encoded, name);
        return {
          type: 'function',
          function: {
            name: encoded,
            description: definition.description,
            parameters: definition.inputSchema,
          },
        };
      }),
    );
    const history = request.history ?? [{ role: 'user', content: request.message }];
    let response: Response;
    try {
      response = await this.request(config.baseUrl + '/chat/completions', {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: toChatMessages(
            request.instructions,
            config.images ? (latestImages(history) ?? []) : (withoutImages(history) ?? []),
            config.images === true,
          ),
          ...(tools.length ? { tools } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new ConnectionError('The custom model is unreachable: ' + String(error));
    }
    if (!response.ok) throw await failure(response);
    const reply = await readChat(response, request);
    const extra = {
      usage: reply.usage,
      contextWindow: config.contextWindow ?? 128_000,
    };
    const calls = reply.calls.map((call) => {
      const name = names.get(call.name);
      if (!name) throw new Error('Model returned an unknown tool call.');
      let input: unknown;
      try {
        input = JSON.parse(call.arguments || '{}');
      } catch {
        throw new Error('Invalid tool arguments.');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid tool arguments.');
      return { name, input: input as Record<string, unknown>, callId: call.id };
    });
    const items: Item[] = [
      ...(reply.text
        ? [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: reply.text }],
            },
          ]
        : []),
      ...reply.calls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments || '{}',
      })),
    ];
    const narration = reply.text || undefined;
    if (calls.length > 1) return { type: 'tools', calls, narration, items, ...extra };
    if (calls.length) return { type: 'tool', ...calls[0], narration, items, ...extra };
    if (!reply.text) throw new Error('Model completed without a message or tool call.');
    return { type: 'text', text: reply.text, items, ...extra };
  }
}

async function failure(response: Response): Promise<Error> {
  if ([401, 403].includes(response.status)) return new SignInRequired(keyProblem);
  if ([408, 429, 500, 502, 503, 504].includes(response.status))
    return new ConnectionError('The custom model connection was interrupted.');
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string } | string;
  };
  const error = typeof body.error === 'string' ? { message: body.error } : body.error;
  const text = error?.message ?? `Custom model request failed: HTTP ${response.status}`;
  return overflow(error?.code, error?.message) ? new ContextOverflow(text) : new Error(text);
}

/** Reads a Chat Completions stream: text, reasoning, tool calls built from their fragments, usage. */
async function readChat(response: Response, request: ModelRequest) {
  if (!response.body) throw new Error('Model returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls: { id: string; name: string; arguments: string }[] = [];
  let buffer = '',
    text = '',
    reasoning = '',
    size = 0,
    finished = false;
  let usage: Usage | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      size += value?.length ?? 0;
      if (size > 16 * 1024 * 1024) throw new Error('Model response exceeded 16 MiB.');
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        buffer = buffer.slice(end + 2);
        if (!data) continue;
        if (data === '[DONE]') return { text, calls: fill(calls), usage };
        const chunk = JSON.parse(data);
        if (chunk.error) {
          const message = chunk.error.message ?? 'Model response failed.';
          throw overflow(chunk.error.code, message)
            ? new ContextOverflow(message)
            : new Error(message);
        }
        if (chunk.usage && Number.isFinite(chunk.usage.prompt_tokens))
          usage = {
            input: chunk.usage.prompt_tokens,
            output: Number(chunk.usage.completion_tokens) || 0,
            cached: Number(chunk.usage.prompt_tokens_details?.cached_tokens) || undefined,
          };
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          const thought = delta.reasoning_content ?? delta.reasoning;
          if (typeof thought === 'string' && thought) {
            reasoning += thought;
            request.onReasoning?.(reasoning);
          }
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            request.onText?.(text);
          }
          for (const part of delta.tool_calls ?? []) {
            const index = Number.isSafeInteger(part.index) ? part.index : calls.length;
            const call = (calls[index] ??= { id: '', name: '', arguments: '' });
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) call.arguments += part.function.arguments;
          }
          if (choice.finish_reason === 'length' && !calls.length && !text)
            throw new ContextOverflow('The custom model ran out of room for its answer.');
          if (choice.finish_reason) finished = true;
        }
      }
      if (done) {
        // Some servers end the stream without [DONE] after the final chunk.
        if (finished) return { text, calls: fill(calls), usage };
        throw new ConnectionError('Model stream interrupted before completion.');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
/** Servers that omit call ids still need one per call to pair calls with their results. */
const fill = (calls: { id: string; name: string; arguments: string }[]) =>
  calls.filter(Boolean).map((call) => ({ ...call, id: call.id || 'call_' + crypto.randomUUID() }));
