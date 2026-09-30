import Ajv from 'ajv';
import { Store } from '../browser/store';
import { createFilesystem } from '../browser/filesystem';
import { Plugins } from '../plugins/loader';
import { MockModel } from './mock-model';
import { localTools } from './tools';
import {
  errorText,
  message,
  type Conversation,
  type Model,
  type Skill,
  type Binding,
} from './types';

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Cancelled'));
    if (signal.aborted) {
      promise.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const key = (id: string) => `conversation:${id}`;
const printable = (value: unknown) =>
  (typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'Done.')).slice(0, 65536);
const builtinSkill: Skill = {
  name: 'workspace',
  description: 'Work with the shared local files and the browser shell.',
  path: 'skills/local/workspace/SKILL.md',
  content:
    '# Local workspace\nUse /workspace for files. Shell execution is just-bash, with no native processes or network commands. Tools may be replaced by an enabled plugin; check the active provider. Do not assume a remote workspace contains local files.',
};

export class Runtime {
  readonly plugins: Plugins;
  private active = new Map<string, AbortController>();
  private ajv = new Ajv({ strict: false });
  private workspace: ReturnType<typeof createFilesystem>;
  constructor(
    readonly store = new Store(),
    private changed: () => void = () => {},
    private model: Model = new MockModel(),
  ) {
    this.plugins = new Plugins(store);
    this.workspace = createFilesystem(store);
  }
  async conversations(): Promise<Conversation[]> {
    return (await this.store.entries<Conversation>('conversation:'))
      .map(([, c]) => c)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async create(): Promise<Conversation> {
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: 'New conversation',
      messages: [],
      pending: [],
      status: 'idle',
      updatedAt: Date.now(),
    };
    await this.store.put(key(conversation.id), conversation);
    this.changed();
    return conversation;
  }
  private async update(
    id: string,
    update: (c: Conversation) => Conversation,
  ): Promise<Conversation> {
    const result = await this.store.update<Conversation>(key(id), (c) => {
      if (!c) throw new Error('Conversation not found.');
      return update(c);
    });
    this.changed();
    return result;
  }
  async submit(id: string, text: string): Promise<void> {
    if (typeof text !== 'string' || !text.trim() || text.length > 16384)
      throw new Error('Enter a message up to 16,384 characters.');
    const entry = message('user', text);
    await this.update(id, (c) => {
      if (c.messages.length > 1000)
        throw new Error('Start a new conversation; this one reached its prototype limit.');
      return {
        ...c,
        title: c.messages.length ? c.title : text.split('\n')[0].slice(0, 50),
        messages: [...c.messages, entry],
        pending: [...c.pending, entry.id],
        status: c.status === 'needs_review' ? c.status : 'running',
        updatedAt: Date.now(),
      };
    });
  }
  async run(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    this.active.set(id, controller);
    let acquired = true;
    const work = async () => {
      let c = await this.store.get<Conversation>(key(id));
      if (!c || c.status === 'needs_review' || c.status === 'stopped') return;
      const pinned = c.plugins ?? (await this.plugins.list());
      await this.update(id, (value) => ({ ...value, plugins: pinned }));
      let skills = [builtinSkill];
      const { bindings, sources } = await this.plugins.snapshot(
        localTools(await this.workspace, () => skills),
        pinned,
      );
      while (!controller.signal.aborted) {
        c = await this.store.get<Conversation>(key(id));
        if (!c || c.status === 'needs_review') break;
        if (!c.activeMessage) {
          if (!c.pending.length) {
            await this.update(id, (value) => ({ ...value, status: 'idle', plugins: undefined }));
            break;
          }
          c = await this.update(id, (value) => ({
            ...value,
            activeMessage: value.pending[0],
            pending: value.pending.slice(1),
            call: undefined,
            status: 'running',
          }));
        }
        const activeMessage = c.messages.find((m) => m.id === c!.activeMessage)!;
        const sync = await this.plugins.sync(sources, controller.signal);
        skills = [builtinSkill, ...sync.skills];
        if (sync.warnings.length)
          await this.update(id, (value) => ({
            ...value,
            messages: [...value.messages, message('notice', sync.warnings.join('\n'))],
          }));
        const instructions =
          'Available native skills:\n' +
          skills.map((s) => `${s.name}: ${s.description}\nPath: ${s.path}`).join('\n\n');
        let result = c.call?.state === 'completed' ? c.call.result : undefined;
        for (let step = 0; step < 20; step++) {
          const output = await abortable(
            this.model.next(
              { message: activeMessage.text, instructions, tools: Object.keys(bindings), result },
              controller.signal,
            ),
            controller.signal,
          );
          if (output.type === 'text') {
            await this.update(id, (value) => ({
              ...value,
              messages: [...value.messages, message('assistant', output.text)],
              activeMessage: undefined,
              call: undefined,
              updatedAt: Date.now(),
            }));
            break;
          }
          const binding = bindings[output.name];
          if (!binding) throw new Error('Tool is unavailable: ' + output.name);
          const validate = this.ajv.compile(binding.tool.inputSchema);
          if (!validate(output.input))
            throw new Error('Invalid tool arguments: ' + this.ajv.errorsText(validate.errors));
          await this.update(id, (value) => ({
            ...value,
            call: {
              id: crypto.randomUUID(),
              name: output.name,
              input: output.input,
              provider: binding.provider,
              state: 'pending',
            },
          }));
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
          try {
            signal.throwIfAborted();
            const response = await abortable(
              binding.tool.execute(output.input, {
                signal,
                checkpoint: async (operationId) => {
                  await this.update(id, (value) => ({
                    ...value,
                    call: value.call ? { ...value.call, operationId } : value.call,
                  }));
                },
              }),
              signal,
            );
            result = printable(response);
            await this.update(id, (value) => ({
              ...value,
              call: { ...value.call!, state: 'completed', result },
              messages: [
                ...value.messages,
                message('tool', result!, `${output.name} · ${binding.provider}`),
              ],
            }));
          } catch (error) {
            await this.update(id, (value) => ({
              ...value,
              status: 'needs_review',
              call: { ...value.call!, state: 'unknown' },
              messages: [
                ...value.messages,
                message(
                  'notice',
                  `Tool outcome needs review: ${errorText(error)}. Changes may already have happened.`,
                ),
              ],
            }));
            if (controller.signal.aborted) await this.requestCancellation(binding, id);
            return;
          }
          // Steering joins at a tool boundary, before any further model/tool calls.
          const latest = await this.store.get<Conversation>(key(id));
          if (latest?.pending.length) {
            await this.update(id, (value) => ({
              ...value,
              messages: [
                ...value.messages,
                message('notice', 'Applied your new message at the tool boundary.'),
              ],
              activeMessage: undefined,
              call: undefined,
            }));
            break;
          }
          if (step === 19) throw new Error('Turn reached the 20-step prototype limit.');
        }
      }
    };
    try {
      if (globalThis.navigator?.locks)
        await navigator.locks.request(
          'kinetik-conversation:' + id,
          { ifAvailable: true },
          (lock) => {
            if (!lock) {
              acquired = false;
              return;
            }
            return work();
          },
        );
      else await work();
    } catch (error) {
      await this.update(id, (c) => ({
        ...c,
        status: 'stopped',
        activeMessage: undefined,
        call: undefined,
        plugins: undefined,
        messages: [
          ...c.messages,
          message('notice', controller.signal.aborted ? 'Stopped.' : errorText(error)),
        ],
      }));
    } finally {
      this.active.delete(id);
    }
    if (!acquired) return;
    const next = await this.store.get<Conversation>(key(id));
    if (
      next &&
      ['running', 'queued', 'idle'].includes(next.status) &&
      (next.pending.length || (next.status === 'queued' && next.activeMessage))
    )
      await this.run(id);
  }
  private async requestCancellation(binding: Binding, id: string): Promise<void> {
    const c = await this.store.get<Conversation>(key(id));
    if (c?.call?.operationId && binding.tool.cancel) {
      try {
        await binding.tool.cancel(c.call.operationId);
      } catch {
        await this.update(id, (value) => ({
          ...value,
          messages: [
            ...value.messages,
            message('notice', 'Provider cancellation could not be confirmed.'),
          ],
        }));
      }
    }
  }
  async stop(id: string): Promise<void> {
    this.active.get(id)?.abort(new Error('Stopped by user'));
    await this.update(id, (c) => ({
      ...c,
      status: c.status === 'needs_review' ? c.status : 'stopped',
      pending: [],
    }));
  }
  async recover(): Promise<void> {
    for (const c of await this.conversations()) {
      if (
        !['running', 'queued'].includes(c.status) &&
        !(c.status === 'stopped' && c.call?.state === 'pending')
      )
        continue;
      const recover = async () => {
        if (c.call?.state === 'pending') {
          try {
            const snapshot = await this.plugins.snapshot(
              localTools(await this.workspace, () => [builtinSkill]),
              c.plugins ?? [],
            );
            const tool = snapshot.bindings[c.call.name]?.tool;
            if (c.status !== 'stopped' && tool?.recover && c.call.operationId) {
              const signal = AbortSignal.timeout(10000);
              const status = await abortable(tool.recover(c.call.operationId, signal), signal);
              if (status.done) {
                await this.update(c.id, (value) => ({
                  ...value,
                  status: 'queued',
                  call: { ...value.call!, state: 'completed', result: printable(status.result) },
                }));
                return;
              }
            }
          } catch {
            /* Unavailable plugins or reconciliation failures leave an explicit unknown outcome. */
          }
          await this.update(c.id, (value) => ({
            ...value,
            status: 'needs_review',
            call: { ...value.call!, state: 'unknown' },
            messages: [
              ...value.messages,
              message(
                'notice',
                'The worker stopped during a tool call. Review its outcome before continuing.',
              ),
            ],
          }));
        } else await this.update(c.id, (value) => ({ ...value, status: 'queued' }));
      };
      if (globalThis.navigator?.locks)
        await navigator.locks.request(
          'kinetik-conversation:' + c.id,
          { ifAvailable: true },
          (lock) => (lock ? recover() : undefined),
        );
      else await recover();
    }
  }
  async resolve(id: string, retry: boolean): Promise<void> {
    await this.update(id, (c) => {
      if (c.status !== 'needs_review' || !c.call)
        throw new Error('No uncertain tool call to resolve.');
      return {
        ...c,
        status: 'queued',
        call: retry
          ? undefined
          : {
              ...c.call,
              state: 'completed',
              result: 'User resolved the uncertain call without retrying.',
            },
      };
    });
  }
  async importFile(name: string, bytes: Uint8Array): Promise<void> {
    if (
      !name ||
      name.includes('/') ||
      name.includes('\\') ||
      name === '.' ||
      name === '..' ||
      bytes.byteLength > 4 * 1024 * 1024
    )
      throw new Error('Import a file up to 4 MiB with a plain filename.');
    await (await this.workspace).fs.writeFile('/workspace/' + name, bytes);
    this.changed();
  }
  async exportFile(path: string): Promise<Uint8Array> {
    return (await this.workspace).fs.readFileBuffer(path);
  }
}
