import {
  ConnectionError,
  ContextOverflow,
  ModelRejected,
  SignInRequired,
} from '../core/connection-error';
import type { ModelRequest, ModelStep } from '../core/types';

type Item = Record<string, unknown>;

/** A provider-safe tool name: readable prefix plus a hash, so any name round-trips. */
export async function toolName(name: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
  const suffix = [...new Uint8Array(bytes)]
    .slice(0, 10)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) + '_' + suffix;
}

/** Encodes every offered tool; `names` maps an encoded name back to Kinetik's. */
export async function encodeTools<T>(
  definitions: ModelRequest['definitions'],
  shape: (name: string, definition: { description: string; inputSchema: unknown }) => T,
) {
  const names = new Map<string, string>();
  const tools = await Promise.all(
    Object.entries(definitions ?? {}).map(async ([name, definition]) => {
      const encoded = await toolName(name);
      names.set(encoded, name);
      return shape(encoded, definition);
    }),
  );
  return { tools, names };
}

export const overflow = (code: unknown, text: unknown) =>
  code === 'context_length_exceeded' ||
  /context (window|length)|maximum context|too many (input )?tokens/i.test(String(text ?? ''));

/** An error the provider reported: too long, busy for now, or a refusal of this request. */
export const providerError = (code: unknown, message: string) =>
  overflow(code, message)
    ? new ContextOverflow(message)
    : /server_error|rate_limit|overloaded|unavailable|timeout/i.test(String(code ?? ''))
      ? new ConnectionError(message)
      : new ModelRejected(message);

/** The error a failed HTTP response means for the turn: sign in, wait, shorten, or rejected. */
export async function httpFailure(
  response: Response,
  text: { signIn: string; interrupted: string; failed: string },
): Promise<Error> {
  if ([401, 403].includes(response.status)) return new SignInRequired(text.signIn);
  if ([408, 429, 500, 502, 503, 504].includes(response.status))
    return new ConnectionError(text.interrupted);
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string } | string;
  };
  const error = typeof body.error === 'string' ? { message: body.error } : body.error;
  return providerError(error?.code, error?.message ?? `${text.failed}: HTTP ${response.status}`);
}

export const streamDone = Symbol('done');
/** Parsed server-sent events; `[DONE]` arrives as `streamDone`. Ends when the stream does. */
export async function* sseEvents(response: Response): AsyncGenerator<any> {
  if (!response.body) throw new Error('Model returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
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
        if (data) yield data === '[DONE]' ? streamDone : JSON.parse(data);
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type RawCall = { name: string; arguments: string; callId: string };
/** One model reply as a step. A call must name an offered tool and carry an object input. */
export function toStep(
  text: string,
  calls: RawCall[],
  names: Map<string, string>,
  items: Item[],
  extra: Pick<ModelStep, 'usage' | 'contextWindow'>,
): ModelStep {
  const decoded = calls.map((call) => {
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
    return { name, input: input as Record<string, unknown>, callId: call.callId };
  });
  const narration = text || undefined;
  if (decoded.length > 1) return { type: 'tools', calls: decoded, narration, items, ...extra };
  if (decoded.length) return { type: 'tool', ...decoded[0], narration, items, ...extra };
  if (!text) throw new Error('Model completed without a message or tool call.');
  return { type: 'text', text, items, ...extra };
}

const imagePart = (part: { type?: string }, text: string) =>
  part.type === 'input_image' ? { type: 'input_text', text } : part;

/** Models without image input get a note in place of each photo instead of a rejected request. */
export function withoutImages(history: Item[] | undefined) {
  return history?.map((item) =>
    Array.isArray(item.content)
      ? {
          ...item,
          content: item.content.map((part: { type?: string }) =>
            imagePart(part, '[A photo is attached, but this model cannot view images.]'),
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
export function latestImages(history: Item[] | undefined) {
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
            keep.has(part)
              ? part
              : imagePart(
                  part,
                  '[An earlier photo is no longer shown to keep the request small. Its file path is listed in this message.]',
                ),
          ),
        }
      : item,
  );
}
