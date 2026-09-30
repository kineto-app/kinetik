import { Bash, type CommandName } from 'just-bash/browser';
import type { createFilesystem } from '../browser/filesystem';
import type { Binding, Skill } from './types';
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
): Record<string, Binding> {
  const { fs } = workspace;
  const path = (value: unknown) => fs.resolvePath('/workspace', String(value));
  const bind = (
    description: string,
    inputSchema: Record<string, unknown>,
    execute: Binding['tool']['execute'],
  ): Binding => ({ provider: 'local', tool: { description, inputSchema, execute } });
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
    ),
    read: bind(
      'Read a UTF-8 file from the shared browser filesystem.',
      schema({ path: text }, ['path']),
      async (input) => fs.readFile(path(input.path)),
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
    ),
  };
}
