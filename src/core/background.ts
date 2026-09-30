import Ajv from 'ajv';
import { Store } from '../browser/store';
import { errorText, type Binding, type Conversation, type InstalledPlugin } from './types';

export interface BackgroundProcess {
  id: string;
  conversationId: string;
  tool: string;
  provider: string;
  input: Record<string, unknown>;
  plugins: InstalledPlugin[];
  state: 'running' | 'completed' | 'interrupted' | 'cancelled';
  operationId?: string;
  result?: string;
  delivered?: boolean;
  cancelRequested?: boolean;
  deadline: number;
}
interface Host {
  resolve(job: BackgroundProcess): Promise<Binding>;
  wake(job: BackgroundProcess): Promise<void>;
}
const key = (id: string) => 'background:' + id;
const output = (value: unknown) =>
  (typeof value === 'string'
    ? value
    : (JSON.stringify(value, (key, value) => (key === '_meta' ? undefined : value)) ?? 'Done.')
  ).slice(0, 16000);

/** A persisted completion outbox, independent of the originating model turn. */
export class BackgroundProcesses {
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(
    private store: Store,
    private host: Host,
  ) {}

  async list(conversationId: string) {
    return (await this.store.entries<BackgroundProcess>('background:'))
      .map(([, job]) => job)
      .filter((job) => job.conversationId === conversationId);
  }

  binding(
    conversationId: string,
    plugins: InstalledPlugin[],
    bindings: Record<string, Binding>,
  ): Binding {
    return {
      provider: 'local',
      tool: {
        description:
          'Start a long tool call without holding the agent turn open. Returns a job ID immediately. Its final result automatically wakes this conversation once; do not poll. Use list to inspect jobs or cancel to stop one. Local jobs cannot survive browser worker termination.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'list', 'cancel'] },
            tool: { type: 'string' },
            input: { type: 'object' },
            id: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000 },
          },
          required: ['action'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          context.signal.throwIfAborted();
          if (input.action === 'list')
            return (await this.list(conversationId)).map(
              ({ id, tool, provider, state, result }) => ({ id, tool, provider, state, result }),
            );
          if (input.action === 'cancel') {
            const job = await this.store.get<BackgroundProcess>(key(String(input.id)));
            if (!job || job.conversationId !== conversationId)
              throw new Error('Background job not found.');
            await this.cancel(job);
            const current = (await this.store.get<BackgroundProcess>(key(job.id)))!;
            return {
              id: job.id,
              state: current.state,
              cancellationRequested: current.cancelRequested ?? false,
              note: 'Effects may already have occurred.',
            };
          }
          if (input.action !== 'start') throw new Error('Unknown background action.');
          const name = String(input.tool ?? 'exec');
          const binding = bindings[name];
          if (
            name === 'background' ||
            name === 'automation' ||
            !binding ||
            (binding.tool.visibility && !binding.tool.visibility.includes('model'))
          )
            throw new Error('Tool is unavailable for background execution.');
          const args = input.input ?? {};
          if (!new Ajv({ strict: false }).compile(binding.tool.inputSchema)(args))
            throw new Error('Invalid background tool arguments.');
          if (
            (await this.list(conversationId)).filter((job) => job.state === 'running').length >= 8
          )
            throw new Error('Maximum eight background jobs per conversation.');
          const conversation = await this.store.get<Conversation>('conversation:' + conversationId);
          if (!conversation?.call)
            throw new Error('Background start requires a journaled tool call.');
          const id = conversation.call.id;
          const existing = await this.store.get<BackgroundProcess>(key(id));
          if (existing) return { id, state: existing.state };
          const job: BackgroundProcess = {
            id,
            conversationId,
            tool: name,
            provider: binding.provider,
            plugins,
            input: args as Record<string, unknown>,
            state: 'running',
            deadline: Date.now() + Number(input.timeoutMs ?? 300000),
          };
          await this.store.put(key(id), job);
          if (context.signal.aborted) {
            await this.cancel(job);
            return { id, state: 'cancelled' };
          }
          this.launch(job, binding, false);
          return {
            id,
            state: 'running',
            note: 'Completion will wake this conversation. Do not poll.',
          };
        },
      },
    };
  }

  private launch(job: BackgroundProcess, binding: Binding, recovering: boolean) {
    if (this.active.has(job.id)) return;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Background job timed out.')),
      Math.max(1, job.deadline - Date.now()),
    );
    const signal = controller.signal;
    // Defer execution until the active entry exists, including for synchronous tools.
    const promise = Promise.resolve()
      .then(async () => {
        try {
          signal.throwIfAborted();
          const work = async () => {
            if (recovering) {
              if (!job.operationId || !binding.tool.recover)
                throw new Error('Execution was interrupted; it was not restarted.');
              const status = await binding.tool.recover(job.operationId, signal);
              if (status.done) return status.result;
              if (!binding.tool.wait)
                throw new Error('Provider cannot wait for the existing job. It was not restarted.');
              return binding.tool.wait(job.operationId, signal);
            }
            const initial = await binding.tool.execute(job.input, {
              signal,
              background: true,
              checkpoint: async (operationId) => {
                job.operationId = operationId;
                await this.store.update<BackgroundProcess>(key(job.id), (previous) => ({
                  ...previous!,
                  operationId,
                }));
              },
            });
            // A provider that starts asynchronous remote work owns its completion transport.
            if (job.operationId && binding.tool.wait)
              return binding.tool.wait(job.operationId, signal);
            return initial;
          };
          const result = await new Promise<unknown>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            void work()
              .then(resolve, reject)
              .finally(() => signal.removeEventListener('abort', abort));
          });
          await this.finish(job, 'completed', output(result));
        } catch (error) {
          if (signal.aborted && job.operationId && binding.tool.cancel) {
            // Cancellation cannot keep a worker alive indefinitely.
            await Promise.race([
              binding.tool.cancel(job.operationId).catch(() => {}),
              new Promise((resolve) => setTimeout(resolve, 1000)),
            ]);
          }
          await this.finish(
            job,
            'interrupted',
            errorText(error) + ' Effects may already have occurred; do not automatically retry.',
          );
        } finally {
          clearTimeout(timeout);
        }
      })
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, { controller, promise });
    // drain() keeps service-worker events alive; retain failures for recovery without an unhandled rejection.
    void promise.catch(() => {});
  }

  private async finish(job: BackgroundProcess, state: BackgroundProcess['state'], result: string) {
    const saved = await this.store.update<BackgroundProcess>(key(job.id), (previous) =>
      previous!.state !== 'running'
        ? previous!
        : {
            ...previous!,
            state: previous!.cancelRequested ? 'cancelled' : state,
            result,
          },
    );
    await this.deliver(saved);
  }
  private async deliver(job: BackgroundProcess) {
    if (job.delivered) return;
    await this.host.wake(job);
    await this.store.update<BackgroundProcess>(key(job.id), (previous) => ({
      ...previous!,
      delivered: true,
    }));
  }
  async cancel(job: BackgroundProcess) {
    if (job.state !== 'running') return;
    await this.store.update<BackgroundProcess>(key(job.id), (previous) => ({
      ...previous!,
      cancelRequested: true,
    }));
    this.active.get(job.id)?.controller.abort(new Error('Background job cancelled.'));
    if (!this.active.has(job.id)) {
      try {
        if (job.operationId)
          await Promise.race([
            this.host.resolve(job).then((binding) => binding.tool.cancel?.(job.operationId!)),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
      } catch {
        /* Outcome remains explicit below. */
      }
      await this.finish(job, 'cancelled', 'Cancelled. Effects may already have occurred.');
    }
  }
  async cancelConversation(id: string) {
    await Promise.all((await this.list(id)).map((job) => this.cancel(job)));
  }
  async recover() {
    for (const [, job] of await this.store.entries<BackgroundProcess>('background:')) {
      if (this.active.has(job.id)) continue;
      if (job.state !== 'running') {
        await this.deliver(job);
        continue;
      }
      if (job.cancelRequested) {
        await this.cancel(job);
        continue;
      }
      if (!job.operationId) {
        await this.finish(
          job,
          'interrupted',
          'The browser worker stopped. Local execution cannot continue and was not restarted. Check any partial effects.',
        );
        continue;
      }
      try {
        this.launch(job, await this.host.resolve(job), true);
      } catch (error) {
        await this.finish(job, 'interrupted', errorText(error) + ' The job was not restarted.');
      }
    }
  }
  async drain() {
    while (this.active.size)
      await Promise.allSettled([...this.active.values()].map((item) => item.promise));
  }
}
