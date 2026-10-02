import {
  createModels,
  isContextOverflow,
  type AssistantMessage,
  type ImageContent,
  type TextContent,
  type Message,
  type MutableModels,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { ConnectionError, ContextOverflow, SignInRequired } from './connection-error';
import { toolName } from './openai-model';
import type { Model, ModelRequest, ModelStep } from './types';

export type ProviderId = 'anthropic' | 'google';
export const providerNames: Record<ProviderId, string> = { anthropic: 'Claude', google: 'Gemini' };
/** The models offered for each provider; the first is the default. */
export const providerModels: Record<ProviderId, { id: string; name: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  ],
  google: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
  ],
};
export const isProvider = (value: unknown): value is ProviderId =>
  value === 'anthropic' || value === 'google';
/** Stored under the `connection-token:` prefix: kept out of exports, and in secure storage on devices. */
export const providerKey = (provider: ProviderId) => 'connection-token:provider:' + provider;
export type ProviderCredential = { apiKey: string; baseUrl?: string };

type Item = Record<string, unknown>;
let registry: MutableModels | undefined;
function models() {
  if (!registry) {
    registry = createModels();
    registry.setProvider(anthropicProvider());
    registry.setProvider(googleProvider());
  }
  return registry;
}
const noUsage: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as PiUsage;

function userContent(content: unknown): Extract<Message, { role: 'user' }>['content'] {
  if (!Array.isArray(content)) return String(content ?? '');
  const parts: (TextContent | ImageContent)[] = [];
  for (const part of content as { type?: string; text?: string; image_url?: string }[]) {
    if (part.type === 'input_text') parts.push({ type: 'text', text: part.text ?? '' });
    const image =
      part.type === 'input_image' && /^data:([^;]+);base64,(.*)$/.exec(part.image_url ?? '');
    if (image) parts.push({ type: 'image', mimeType: image[1], data: image[2] });
  }
  return parts;
}

/**
 * Kinetik stores model input in the Responses format. This reads it as a pi transcript for
 * `provider`. Items only another provider can read (OpenAI encrypted reasoning and compaction,
 * or another provider's thinking signatures) are left out.
 */
export function toPiMessages(
  history: Item[],
  target: { api: string; provider: string; id: string },
): Message[] {
  const messages: Message[] = [];
  const names = new Map<string, string>();
  let assistant: AssistantMessage | undefined;
  const flush = () => {
    if (assistant?.content.length) messages.push(assistant);
    assistant = undefined;
  };
  const open = () =>
    (assistant ??= {
      role: 'assistant',
      content: [],
      api: target.api,
      provider: target.provider,
      model: target.id,
      usage: noUsage,
      stopReason: 'stop',
      timestamp: 0,
    } as AssistantMessage);
  for (const item of history) {
    if (item.role === 'user' && item.type === undefined) {
      flush();
      messages.push({ role: 'user', content: userContent(item.content), timestamp: 0 });
    } else if (item.type === 'message' && item.role === 'assistant') {
      const text = ((item.content ?? []) as { text?: string }[]).map((p) => p.text ?? '').join('');
      if (text) open().content.push({ type: 'text', text });
    } else if (item.type === 'pi_thinking' && item.provider === target.provider) {
      open().content.push({
        type: 'thinking',
        thinking: String(item.thinking ?? ''),
        ...(item.signature ? { thinkingSignature: String(item.signature) } : {}),
        ...(item.redacted ? { redacted: true } : {}),
      });
    } else if (item.type === 'function_call') {
      names.set(String(item.call_id), String(item.name));
      let input = {};
      try {
        input = JSON.parse(String(item.arguments ?? '{}'));
      } catch {
        /* A malformed stored call still needs its slot; its output explains what happened. */
      }
      open().content.push({
        type: 'toolCall',
        id: String(item.call_id),
        name: String(item.name),
        arguments: input,
        ...(item.provider === target.provider && item.thought_signature
          ? { thoughtSignature: String(item.thought_signature) }
          : {}),
      });
    } else if (item.type === 'function_call_output') {
      flush();
      const output = String(item.output ?? '');
      messages.push({
        role: 'toolResult',
        toolCallId: String(item.call_id),
        toolName: names.get(String(item.call_id)) ?? 'tool',
        content: [{ type: 'text', text: output }],
        isError: output.startsWith('Error:'),
        timestamp: 0,
      });
    }
  }
  flush();
  return messages;
}

/** A pi reply as Responses-format items, tagged with the provider whose signatures it carries. */
export function fromPiMessage(message: AssistantMessage, provider: string): Item[] {
  return message.content.map((block) => {
    if (block.type === 'text')
      return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: block.text }],
      };
    if (block.type === 'thinking')
      return {
        type: 'pi_thinking',
        provider,
        thinking: block.thinking,
        ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}),
        ...(block.redacted ? { redacted: true } : {}),
      };
    return {
      type: 'function_call',
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.arguments ?? {}),
      provider,
      ...(block.thoughtSignature ? { thought_signature: block.thoughtSignature } : {}),
    };
  });
}

/** Claude and Gemini through pi-ai with the user's own API key. */
export class PiModel implements Model {
  constructor(
    private credential: (provider: ProviderId) => Promise<ProviderCredential | undefined>,
  ) {}
  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    const [provider, id] = (request.pin ?? '').split(':') as [ProviderId, string];
    if (!isProvider(provider)) throw new Error('No Claude or Gemini model is selected.');
    const key = await this.credential(provider);
    if (!key?.apiKey)
      throw new SignInRequired(`Add your ${providerNames[provider]} API key in Settings → Models.`);
    const known = models().getModel(provider, id);
    if (!known) throw new Error(`${providerNames[provider]} model ${id} is not available.`);
    const model = key.baseUrl ? { ...known, baseUrl: key.baseUrl } : known;
    const names = new Map<string, string>();
    const tools = await Promise.all(
      Object.entries(request.definitions ?? {}).map(async ([name, definition]) => {
        const encoded = await toolName(name);
        names.set(encoded, name);
        return {
          name: encoded,
          description: definition.description,
          parameters: definition.inputSchema as never,
        };
      }),
    );
    const stream = models().streamSimple(
      model,
      {
        systemPrompt: request.instructions,
        messages: toPiMessages(request.history ?? [{ role: 'user', content: request.message }], {
          api: model.api,
          provider,
          id: model.id,
        }),
        tools,
      },
      { apiKey: key.apiKey, signal, ...(model.reasoning ? { reasoning: 'medium' } : {}) },
    );
    let text = '';
    let thinking = '';
    let reply: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        text += event.delta;
        request.onText?.(text);
      } else if (event.type === 'thinking_delta') {
        thinking += event.delta;
        request.onReasoning?.(thinking);
      } else if (event.type === 'done') reply = event.message;
      else if (event.type === 'error') {
        signal.throwIfAborted();
        throw failure(event.error, model.contextWindow, provider);
      }
    }
    if (!reply) throw new ConnectionError('Model stream ended before completion.');
    const items = fromPiMessage(reply, provider);
    const usage = {
      input: reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite,
      output: reply.usage.output,
      cached: reply.usage.cacheRead || undefined,
    };
    const extra = { usage, contextWindow: model.contextWindow };
    const answer = reply.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const calls = reply.content.flatMap((block) =>
      block.type === 'toolCall'
        ? [{ name: names.get(block.name), input: block.arguments ?? {}, callId: block.id }]
        : [],
    );
    if (calls.some((call) => !call.name)) throw new Error('Model returned an unknown tool call.');
    const decoded = calls as { name: string; input: Record<string, unknown>; callId: string }[];
    if (decoded.length > 1)
      return { type: 'tools', calls: decoded, narration: answer || undefined, items, ...extra };
    if (decoded.length)
      return { type: 'tool', ...decoded[0], narration: answer || undefined, items, ...extra };
    if (!answer) throw new Error('Model completed without a message or tool call.');
    return { type: 'text', text: answer, items, ...extra };
  }
}

function failure(message: AssistantMessage, window: number, provider: ProviderId): Error {
  const text = message.errorMessage ?? 'The model request failed.';
  if (isContextOverflow(message, window)) return new ContextOverflow(text);
  if (/\b(401|403)\b|authentication|api[ -]?key|permission/i.test(text))
    return new SignInRequired(
      `Check your ${providerNames[provider]} API key in Settings → Models.`,
    );
  if (/\b(408|429|5\d\d)\b|overloaded|rate.?limit|fetch|network|timed? ?out/i.test(text))
    return new ConnectionError('The model connection was interrupted.');
  return new Error(text);
}
