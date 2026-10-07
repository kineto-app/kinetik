import { ConnectionError, ContextOverflow, SignInRequired } from '../core/connection-error';
import {
  encodeTools,
  httpFailure,
  latestImages,
  providerError,
  sseEvents,
  streamDone,
  toStep,
  withoutImages,
} from './model-http';
import type { Model, ModelRequest, ModelStep, TurnPin, Usage } from '../core/types';
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

/** How one provider's failures read and what they mean for the turn. */
export interface CompatOptions {
  /** Names the model in messages, as in "The custom model is unreachable". */
  name: string;
  /** Shown when the model is not set up. */
  setUp: string;
  /** The error a failed HTTP response to a request made with `config` means for the turn. */
  failure(response: Response, config: CustomModel): Promise<Error>;
  /** An error the stream reported; `undefined` reads it as any provider's error. */
  streamError?(code: unknown, message: string, config: CustomModel): Error | undefined;
}
const customOptions: CompatOptions = {
  name: 'The custom model',
  setUp: 'Set up the custom model in Settings → ChatGPT → Advanced.',
  failure: (response) =>
    httpFailure(response, {
      signIn: keyProblem,
      interrupted: 'The custom model connection was interrupted.',
      failed: 'Custom model request failed',
    }),
};

/** Any OpenAI-compatible server through its Chat Completions endpoint, with the user's own key. */
export class CompatModel implements Model {
  constructor(
    /** For the turn's pinned model, when one provider serves several. */
    private configuration: (pin?: TurnPin) => Promise<CustomModel | undefined>,
    private request: typeof fetch = fetch.bind(globalThis),
    private options: CompatOptions = customOptions,
  ) {}
  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    const config = await this.configuration(request.pin);
    if (!config) throw new SignInRequired(this.options.setUp);
    const { tools, names } = await encodeTools(request.definitions, (name, definition) => ({
      type: 'function',
      function: { name, description: definition.description, parameters: definition.inputSchema },
    }));
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
          model: request.pin?.model ?? config.model,
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
      throw new ConnectionError(`${this.options.name} is unreachable: ${String(error)}`);
    }
    if (!response.ok) throw await this.options.failure(response, config);
    const reply = await readChat(response, request, this.options, config);
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
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments || '{}',
      })),
    ];
    return toStep(reply.text, reply.calls, names, items, {
      usage: reply.usage,
      contextWindow: config.contextWindow ?? 128_000,
    });
  }
}

/** Reads a Chat Completions stream: text, reasoning, tool calls built from their fragments, usage. */
async function readChat(
  response: Response,
  request: ModelRequest,
  options: CompatOptions,
  config: CustomModel,
) {
  const calls: { id: string; name: string; arguments: string }[] = [];
  let text = '',
    reasoning = '',
    finished = false;
  let usage: Usage | undefined;
  const reply = () => ({ text, calls: fill(calls), usage });
  for await (const chunk of sseEvents(response)) {
    if (chunk === streamDone) return reply();
    if (chunk.error) {
      const text = String(chunk.error.message ?? 'Model response failed.');
      throw (
        options.streamError?.(chunk.error.code, text, config) ??
        providerError(chunk.error.code, text)
      );
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
        throw new ContextOverflow(`${options.name} ran out of room for its answer.`);
      if (choice.finish_reason) finished = true;
    }
  }
  // Some servers end the stream without [DONE] after the final chunk.
  if (finished) return reply();
  throw new ConnectionError('Model stream interrupted before completion.');
}
/** Servers that omit call ids still need one per call to pair calls with their results. */
const fill = (calls: { id: string; name: string; arguments: string }[]) =>
  calls.filter(Boolean).map(({ id, name, arguments: args }) => ({
    name,
    arguments: args,
    callId: id || 'call_' + crypto.randomUUID(),
  }));
