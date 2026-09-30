import type { Model, ModelRequest, ModelStep } from './types';
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
/** Deterministic local fixture, deliberately never presented as an LLM. */
export class MockModel implements Model {
  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep> {
    await delay(80, signal);
    if (request.result !== undefined) return { type: 'text', text: request.result || 'Done.' };
    const [line, ...lines] = request.message.split('\n');
    const match = /^\/(\w+)\s*([\s\S]*)$/.exec(line.trim());
    if (!match)
      return {
        type: 'text',
        text: 'This is the local test model. Try /exec echo hello, /read /workspace/note.txt, /write /workspace/note.txt followed by a new line and its content, /skills, or /tool name {"key":"value"}.',
      };
    const [, command, arg] = match;
    if (command === 'skills') return { type: 'text', text: request.instructions };
    if (command === 'exec')
      return { type: 'tool', name: 'exec', input: { command: [arg, ...lines].join('\n') } };
    if (command === 'write')
      return { type: 'tool', name: 'write', input: { path: arg, content: lines.join('\n') } };
    if (command === 'read' || command === 'list' || command === 'read_skill')
      return { type: 'tool', name: command, input: { path: arg || '/workspace' } };
    if (command === 'tool') {
      const i = arg.indexOf(' ');
      const name = i < 0 ? arg : arg.slice(0, i);
      const input: unknown = i < 0 ? {} : JSON.parse(arg.slice(i + 1) + lines.join('\n'));
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Tool arguments must be a JSON object.');
      return { type: 'tool', name, input: input as Record<string, unknown> };
    }
    return { type: 'text', text: `Unknown test command: /${command}` };
  }
}
