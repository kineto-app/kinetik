import type { Model, ModelRequest, ModelStep, TurnPin, Usage } from '../core/types';
import {
  ConnectionError,
  ContextOverflow,
  isConnectionError,
  SignInRequired,
} from '../core/connection-error';
import { errorText } from '../core/types';
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

/** What OpenAIModel sends: the Responses request plus the account and the turn's pin. */
export type ResponsesBody = {
  account: string;
  pin?: { model?: string; effort?: string };
  request: Record<string, unknown>;
};
/** Delivers a request to ChatGPT: the browser session, or an HTTP endpoint such as the helper. */
export type ResponsesTransport = (body: ResponsesBody, signal: AbortSignal) => Promise<Response>;

export const httpTransport =
  (endpoint: string, request: typeof fetch = fetch.bind(globalThis)): ResponsesTransport =>
  (body, signal) =>
    request(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: { 'Content-Type': 'application/json', 'X-Kinetik-Request': '1' },
      body: JSON.stringify(body),
    });

/** Reads a Responses stream. Success requires the terminal event. */
export async function readResponse(
  response: Response,
  onText?: (text: string) => void,
  meta: { usage?: Usage } = {},
  onReasoning?: (text: string) => void,
): Promise<Record<string, unknown>[]> {
  if (!response.ok)
    throw await httpFailure(response, {
      signIn: 'Reconnect ChatGPT to continue.',
      interrupted: 'The model connection was interrupted.',
      failed: 'Model request failed',
    });
  const started = new Set<number>();
  const finished = new Map<number, Record<string, unknown>>();
  let text = '',
    reasoning = '';
  for await (const event of sseEvents(response)) {
    if (event === streamDone) continue;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (
        !Number.isSafeInteger(event.output_index) ||
        event.output_index < 0 ||
        !event.item ||
        typeof event.item !== 'object'
      )
        throw new Error('Invalid streamed output item.');
      started.add(event.output_index);
      if (event.type === 'response.output_item.done') finished.set(event.output_index, event.item);
    }
    if (event.type === 'response.reasoning_summary_part.added' && reasoning) reasoning += '\n\n';
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
      const message = failure.message ?? 'Model response did not complete.';
      const reason = event.response?.incomplete_details?.reason;
      if (reason === 'max_output_tokens') throw new ContextOverflow(message);
      // An unfinished answer (a content filter, say) is not a refusal of the request itself.
      if (event.type === 'response.incomplete')
        throw new Error(reason ? 'The answer stopped early: ' + reason : message);
      throw providerError(failure.code, message);
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
  throw new ConnectionError('Model stream interrupted before completion.');
}

export class OpenAIModel implements Model {
  constructor(
    private configuration: () => Promise<{
      account: string;
      model: string;
      contextWindow?: number;
      images?: boolean;
    }>,
    private send: ResponsesTransport,
    private compactor?: (
      account: string,
      input: Record<string, unknown>[],
      signal: AbortSignal,
      pin?: TurnPin,
    ) => Promise<Record<string, unknown>[]>,
  ) {}
  async compact(input: Record<string, unknown>[], pin: TurnPin | undefined, signal: AbortSignal) {
    if (!this.compactor) return undefined;
    const config = await this.configuration();
    return this.compactor(config.account, input, signal, pin);
  }
  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    const config = await this.configuration();
    if (!config.account || !config.model)
      throw new SignInRequired('Connect ChatGPT and choose a model in Account.');
    const { tools, names } = await encodeTools(request.definitions, (name, definition) => ({
      type: 'function',
      name,
      description: definition.description,
      parameters: definition.inputSchema,
      strict: false,
    }));
    let response: Response;
    try {
      response = await this.send(
        {
          account: config.account,
          pin: request.pin && { model: request.pin.model, effort: request.pin.effort },
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
        },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (isConnectionError(error) && !(error instanceof ConnectionError))
        throw new ConnectionError('ChatGPT is unreachable: ' + errorText(error));
      throw error;
    }
    const meta: { usage?: Usage } = {};
    const items = await readResponse(response, request.onText, meta, request.onReasoning);
    const text = items
      .filter((item) => item.type === 'message')
      .flatMap((item) => (item.content ?? []) as { text?: string }[])
      .map((part) => part.text ?? '')
      .join('');
    const raw = items.filter((item) => item.type === 'function_call');
    if (raw.some((call) => typeof call.call_id !== 'string' || typeof call.arguments !== 'string'))
      throw new Error('Model returned an unknown tool call.');
    const calls = raw.map((call) => ({
      name: String(call.name),
      arguments: call.arguments as string,
      callId: call.call_id as string,
    }));
    return toStep(text, calls, names, items, {
      usage: meta.usage,
      contextWindow: config.contextWindow,
    });
  }
}
