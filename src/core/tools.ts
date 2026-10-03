import { Bash, type CommandName } from 'just-bash/browser';
import type { createFilesystem } from '../browser/filesystem';
import type { Binding, Skill } from './types';
import type { Store } from './ports';
const text = { type: 'string' };
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const commands: CommandName[] = [
  'echo',
  'printf',
  'cat',
  'ls',
  'pwd',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'sed',
  'awk',
  'sort',
  'uniq',
  'cut',
  'tr',
  'find',
  'tee',
  'sleep',
  'seq',
  'jq',
  'base64',
  'stat',
  'ln',
  'readlink',
  'chmod',
  'true',
  'false',
];
export function localTools(
  workspace: Awaited<ReturnType<typeof createFilesystem>>,
  skills: () => Skill[],
  store: Store,
): Record<string, Binding> {
  const { fs } = workspace;
  const path = (value: unknown) => fs.resolvePath('/workspace', String(value));
  const bind = (
    description: string,
    inputSchema: Record<string, unknown>,
    execute: Binding['tool']['execute'],
    effects?: Pick<Binding['tool'], 'readOnly' | 'command'>,
  ): Binding => ({ provider: 'local', tool: { description, inputSchema, execute, ...effects } });
  return {
    exec: bind(
      'Run a bounded just-bash command in the shared browser filesystem.',
      schema({ command: text }, ['command']),
      async (input, context) => {
        const bash = new Bash({
          fs,
          cwd: '/workspace',
          commands,
          executionLimits: {
            maxExecutionTimeMs: context.background ? 900000 : 15000,
            maxLoopIterations: 10000,
            maxCommandCount: 1000,
            maxOutputSize: 128 * 1024,
          },
        });
        const result = await bash.exec(String(input.command), { signal: context.signal });
        return `${result.stdout}${result.stderr ? '\n' + result.stderr : ''}${result.exitCode ? '\nExit code: ' + result.exitCode : ''}`;
      },
      { command: true },
    ),
    read: bind(
      'Read a UTF-8 file from the shared browser filesystem.',
      schema({ path: text }, ['path']),
      async (input) => fs.readFile(path(input.path)),
      { readOnly: true },
    ),
    write: bind(
      'Replace a UTF-8 file in the shared browser filesystem.',
      schema({ path: text, content: text }, ['path', 'content']),
      async (input) => {
        await fs.writeFile(path(input.path), String(input.content));
        return 'Saved ' + path(input.path);
      },
    ),
    edit: bind(
      'Replace exactly one matching text fragment atomically.',
      schema({ path: text, oldText: text, newText: text }, ['path', 'oldText', 'newText']),
      async (input) => {
        await workspace.edit(path(input.path), String(input.oldText), String(input.newText));
        return 'Edited ' + path(input.path);
      },
    ),
    list: bind(
      'List a directory in the shared browser filesystem.',
      schema({ path: text }, ['path']),
      async (input) => (await fs.readdir(path(input.path))).join('\n'),
      { readOnly: true },
    ),
    show_file: bind(
      'Share a finished local file with the user as a downloadable attachment. Creates a snapshot; later edits do not change it. Writing a file does not share it.',
      schema({ path: text }, ['path']),
      async (input) => {
        const resolved = path(input.path);
        const bytes = await fs.readFileBuffer(resolved);
        const snapshotId = crypto.randomUUID();
        await store.put('shared-file:' + snapshotId, bytes);
        return { file: { path: resolved, name: resolved.split('/').at(-1)!, snapshotId } };
      },
    ),
    ask: bind(
      'Ask the user to choose between a few options shown as buttons. Use when you need a decision; the answer comes back as this tool’s result.',
      {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 300 },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
      async () => {
        throw new Error('The ask tool is answered by the user, not executed.');
      },
    ),
    delegate: bind(
      'Hand a self-contained reading or research task to a helper agent that can only read files and skills. It returns its findings as this tool’s result. Use it for large reading jobs so this chat stays short; describe exactly what to find and report.',
      {
        type: 'object',
        properties: { task: { type: 'string', minLength: 1, maxLength: 4000 } },
        required: ['task'],
        additionalProperties: false,
      },
      async () => {
        throw new Error('The delegate tool is run by the agent runtime.');
      },
      // Its helper only reads, so a restart runs it again and its errors are results.
      { readOnly: true },
    ),
    remember: bind(
      'Propose a new version of the user’s saved memory: short notes about them and their preferences that every chat reads. The user confirms before it is saved. Send the complete new text, not a diff.',
      {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 4000 } },
        required: ['text'],
        additionalProperties: false,
      },
      async () => {
        throw new Error('The remember tool is confirmed by the user, not executed.');
      },
    ),
    read_skill: bind(
      'Read native skill instructions independently of the workspace provider.',
      schema({ path: text }, ['path']),
      async (input) => {
        const skill = skills().find((s) => s.path === input.path);
        if (!skill)
          throw new Error('Unknown native skill path. Use /skills to inspect the catalog.');
        return skill.content;
      },
      { readOnly: true },
    ),
  };
}
