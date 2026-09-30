import { demoTasks } from './demo-tasks';
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
    const example = demoTasks.find((task) => task.prompt === request.message.trim());
    if (example)
      return request.result === undefined
        ? {
            type: 'tool',
            name: 'write',
            input: { path: '/workspace/' + example.filename, content: example.content },
          }
        : request.result.startsWith('Saved ') && request.tools.includes('show_file')
          ? { type: 'tool', name: 'show_file', input: { path: '/workspace/' + example.filename } }
          : { type: 'text', text: example.reply };
    if (request.message.trim() === 'Show my saved files.')
      return request.result === undefined
        ? { type: 'tool', name: 'list', input: { path: '/workspace' } }
        : {
            type: 'text',
            text: request.result
              ? 'Your saved files:\n\n' +
                request.result
                  .split('\n')
                  .map((name) => '• ' + name)
                  .join('\n')
              : 'You haven’t saved any files yet. Try creating a note or adding a file.',
          };
    if (request.result !== undefined) {
      if (request.message.startsWith('/show_file '))
        return { type: 'text', text: 'Here is your file.' };
      if (request.message.startsWith('/bg ') || request.message.startsWith('/tool background ')) {
        const receipt = JSON.parse(request.result);
        if (receipt.id && receipt.state === 'running')
          return { type: 'text', text: 'Started a background task.' };
      }
      return { type: 'text', text: request.result || 'Done.' };
    }
    if (request.message.startsWith('Background job '))
      return {
        type: 'text',
        text: request.message.split('\n')[0].endsWith('completed.')
          ? 'Background task completed.'
          : 'Background task was interrupted. Check its effects before retrying.',
      };
    const [line, ...lines] = request.message.split('\n');
    const match = /^\/(\w+)\s*([\s\S]*)$/.exec(line.trim());
    if (!match)
      return {
        type: 'text',
        text: 'You’re trying the Kinetik preview. I can create a sample note or packing list, or show your saved files. Try one of those examples to get started. Open-ended AI chat will be available when ChatGPT sign-in is connected.',
      };
    const [, command, arg] = match;
    if (command === 'skills') return { type: 'text', text: request.instructions };
    if (command === 'bg')
      return {
        type: 'tool',
        name: 'background',
        input: { action: 'start', tool: 'exec', input: { command: [arg, ...lines].join('\n') } },
      };
    if (command === 'exec')
      return { type: 'tool', name: 'exec', input: { command: [arg, ...lines].join('\n') } };
    if (command === 'write')
      return { type: 'tool', name: 'write', input: { path: arg, content: lines.join('\n') } };
    if (
      command === 'read' ||
      command === 'list' ||
      command === 'read_skill' ||
      command === 'show_file'
    )
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
