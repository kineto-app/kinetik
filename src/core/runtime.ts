import Ajv from 'ajv';
import { toolOutcome } from './tool-outcome';
import { ContextOverflow, isConnectionError, SignInRequired } from './connection-error';
import { Compactor, defaultContextWindow, estimateTokens } from './compaction';
import { localSkills } from './skills';
import { Automations } from './automation';
import { BackgroundProcesses, type BackgroundProcess } from './background';
import { Store } from '../browser/store';
import { ConversationStore, conversationKey as key } from './conversation-store';
import { Attachments, attachmentLock } from './attachments';
import { abortable } from './abortable';
import { functionOutput, printable, withOutput } from './model-input';
import { localReadOnly, ReadOnlyTools } from './read-only';
import { AppCalls } from './apps';
import { WorkspaceFiles } from './workspace-files';
import { migrate } from './migrations';
import { conversationKeys, sweepDaily } from './cleanup';
import { recoverWork, waitForConnection } from './recovery';
import { buildInstructions, builtinSkill, modelVisible, toolDefinitions } from './prompt';
import { createFilesystem } from '../browser/filesystem';
import { Plugins } from '../plugins/loader';
import { MockModel } from '../models/mock';
import { localTools } from './tools';
import {
  errorText,
  message,
  modelMessageText,
  type Conversation,
  type LiveProgress,
  type RuntimeEvent,
  type Model,
  type ModelRequest,
  type Skill,
  type Binding,
  type InstalledPlugin,
  type AppView,
  type Message,
  type ModelStep,
  addUsage,
  needsApproval,
  type Ask,
  type ToolCall,
} from './types';

const maxSteps = 60;
/** Pending messages that interrupt at the next boundary; queued follow-ups wait for the turn to end. */
const steering = (c: Conversation | undefined) =>
  (c?.pending ?? []).filter((id) => c!.messages.find((m) => m.id === id)?.queue !== 'after');
const repeatLimit = 3;
type ToolStep = Extract<ModelStep, { type: 'tool' }>;
type ToolTurn = {
  id: string;
  controller: AbortController;
  bindings: Record<string, Binding>;
  pinned: InstalledPlugin[];
  backgroundTurn: boolean;
};
export class Runtime {
  readonly plugins: Plugins;
  readonly automations: Automations;
  readonly background: BackgroundProcesses;
  /** Tells the user about finished work or a question while the app is in the background. */
  notify: (alert: { conversationId: string; title: string; body: string }) => Promise<void> =
    async () => {};
  private drafts = new Map<string, string>();
  private live = new Map<string, LiveProgress>();
  private active = new Map<string, AbortController>();
  private ajv = new Ajv({ strict: false });
  private chats: ConversationStore;
  private attachments: Attachments;
  private compactor: Compactor;
  private readOnly: ReadOnlyTools;
  private apps: AppCalls;
  private workspaceFiles: WorkspaceFiles;
  private workspace: ReturnType<typeof createFilesystem>;
  constructor(
    readonly store = new Store(),
    private changed: (event?: RuntimeEvent) => void = () => {},
    private model: Model = new MockModel(),
  ) {
    this.chats = new ConversationStore(store, () => this.changed());
    this.plugins = new Plugins(store, (name, text, id) => this.automations.emit(name, text, id));
    this.automations = new Automations(store, this, changed);
    this.workspace = createFilesystem(store);
    this.attachments = new Attachments(store, this.chats, this.plugins, this.workspace);
    this.apps = new AppCalls(store, this.chats, this.plugins);
    this.workspaceFiles = new WorkspaceFiles(store, this.plugins, this.workspace, () =>
      this.changed(),
    );
    this.readOnly = new ReadOnlyTools({
      chats: this.chats,
      ask: (id, request, signal) => this.modelNext(id, request, signal),
      live: this.live,
      progress: (id, live) => this.progress(id, live),
    });
    this.compactor = new Compactor({
      store,
      chats: this.chats,
      model,
      pin: (id) => this.pinFor(id),
      ask: (id, request, signal) => this.modelNext(id, request, signal),
      live: this.live,
      progress: (id, live) => this.progress(id, live),
      changed: () => this.changed(),
    });
    this.background = new BackgroundProcesses(store, {
      resolve: async (job) => {
        const snapshot = await this.plugins.snapshot(
          localTools(await this.workspace, () => [], this.store),
          job.plugins,
        );
        const binding = snapshot.bindings[job.tool];
        if (!binding || binding.provider !== job.provider)
          throw new Error('Background provider unavailable.');
        return binding;
      },
      wake: (job) => this.backgroundCompleted(job),
      changed,
    });
  }
  /** Conversations without their model input, which only the runtime reads. */
  async conversations(): Promise<Conversation[]> {
    return (await this.store.entries<Conversation>('conversation:'))
      .map(([, c]) => ({
        ...c,
        modelInput: undefined,
        draft: this.drafts.get(c.id),
        live: this.live.get(c.id),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async create(): Promise<Conversation> {
    return this.ensureConversation(crypto.randomUUID());
  }
  async ensureConversation(id: string): Promise<Conversation> {
    const conversation: Conversation = {
      id,
      title: 'New chat',
      messages: [],
      pending: [],
      status: 'idle',
      updatedAt: Date.now(),
    };
    const stored = await this.store.update<Conversation>(
      key(id),
      (previous) => previous ?? conversation,
    );
    this.changed();
    return stored;
  }
  private progress(id: string, live: LiveProgress) {
    this.live.set(id, live);
    this.changed({ type: 'progress', conversationId: id, ...live });
  }
  async submit(
    id: string,
    text: string,
    messageId?: string,
    attachmentIds: string[] = [],
    queue?: 'after',
  ): Promise<void> {
    if (
      !Array.isArray(attachmentIds) ||
      attachmentIds.length > 10 ||
      attachmentIds.some((value) => typeof value !== 'string') ||
      new Set(attachmentIds).size !== attachmentIds.length
    )
      throw new Error('Invalid attachments.');
    if (
      typeof text !== 'string' ||
      (!text.trim() && !attachmentIds.length) ||
      text.length > (messageId ? 32768 : 16384)
    )
      throw new Error('Enter a message up to 16,384 characters.');
    if (text.trim() === '/compact' && !attachmentIds.length && !messageId) {
      await this.compact(id);
      return;
    }
    await attachmentLock(id, async () => {
      const entry = message('user', text);
      if (messageId) entry.id = messageId;
      // Queuing only matters while work is in progress.
      const current = await this.store.get<Conversation>(key(id));
      if (queue === 'after' && ['running', 'queued', 'waiting'].includes(current?.status ?? ''))
        entry.queue = 'after';
      const prepared = attachmentIds.length
        ? await this.attachments.prepare(id, attachmentIds)
        : undefined;
      if (prepared) entry.attachments = prepared.files;
      await this.steer(id, entry, true, prepared?.plugins);
      for (const attachment of entry.attachments ?? [])
        await this.store.delete('attachment-bytes:' + attachment.id);
    });
  }
  stageAttachment(id: string, name: string, bytes: Uint8Array, preview?: Uint8Array) {
    return this.attachments.stage(id, name, bytes, preview);
  }
  attachmentPreview(attachmentId: string) {
    return this.attachments.preview(attachmentId);
  }
  removeAttachment(id: string, attachmentId: string) {
    return this.attachments.remove(id, attachmentId);
  }
  private async steer(
    id: string,
    entry: Message,
    wake = true,
    plugins?: InstalledPlugin[],
  ): Promise<void> {
    await this.chats.update(id, (c) => {
      if (c.messages.some((m) => m.id === entry.id)) return c;
      if (entry.role === 'user' && c.messages.length > 1000)
        throw new Error('Start a new conversation; this one reached its prototype limit.');
      return {
        ...c,
        plugins: c.plugins ?? plugins,
        attachments: c.attachments?.filter(
          (f) => !entry.attachments?.some((sent) => sent.id === f.id),
        ),
        title:
          c.messages.length || entry.role !== 'user'
            ? c.title
            : (entry.text.split('\n')[0] || entry.attachments?.[0]?.name || 'New chat').slice(
                0,
                50,
              ),
        messages: [...c.messages, entry],
        pending: wake ? [...c.pending, entry.id] : c.pending,
        status:
          !wake ||
          c.status === 'needs_review' ||
          (entry.source === 'background' && c.status === 'stopped')
            ? c.status
            : c.status === 'running'
              ? 'running'
              : 'queued',
        updatedAt: Date.now(),
      };
    });
  }
  private async backgroundCompleted(job: BackgroundProcess): Promise<void> {
    if (!(await this.store.get(key(job.conversationId)))) return;
    await this.steer(
      job.conversationId,
      {
        ...message(
          'notice',
          `Background job ${job.id} (${job.tool} · ${job.provider}) ${job.state}.\n${job.result ?? ''}`,
        ),
        id: 'background-completed:' + job.id,
        visibility: 'internal',
        source: 'background',
      },
      job.state !== 'cancelled',
    );
    if (job.state !== 'cancelled') await this.run(job.conversationId);
  }
  async run(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    this.active.set(id, controller);
    let acquired = true;
    const work = async () => {
      let c = await this.store.get<Conversation>(key(id));
      if (!c || c.status === 'needs_review' || c.status === 'stopped') return;
      const pinned = c.plugins ?? (await this.plugins.pin(await this.plugins.list()));
      const choice = await this.model.pin?.();
      await this.chats.update(id, (value) => ({
        ...value,
        plugins: pinned,
        status: value.status === 'stopped' ? value.status : 'running',
        // A turn keeps the provider and model it started with, even if the user switches.
        turnModel: value.workStartedAt === undefined ? choice : value.turnModel,
        workStartedAt: value.workStartedAt ?? Date.now(),
        waitingFor: undefined,
      }));
      let skills: Skill[] = [];
      const { bindings, sources } = await this.plugins.snapshot(
        {
          ...localTools(await this.workspace, () => skills, this.store),
          automation: this.automations.binding(),
        },
        pinned,
      );
      bindings.background = this.background.binding(id, pinned, bindings);
      if (bindings.delegate?.provider === 'local')
        bindings.delegate = {
          provider: 'local',
          tool: {
            ...bindings.delegate.tool,
            execute: (input, context) =>
              this.readOnly.helper(id, String(input.task), bindings, context.signal),
          },
        };
      while (!controller.signal.aborted) {
        c = await this.store.get<Conversation>(key(id));
        if (!c || c.status === 'needs_review') break;
        if (!c.activeMessage || c.pending.length) {
          if (!c.pending.length) {
            await this.chats.update(id, (value) => ({
              ...value,
              status: 'idle',
              plugins: undefined,
              workStartedAt: undefined,
            }));
            break;
          }
          const images = await this.attachments.images(c);
          c = await this.chats.update(id, (value) => {
            // Steering joins now; a queued follow-up waits until no steering is left, one at a time.
            const steer = steering(value);
            const taken = steer.length ? steer : value.pending.slice(0, 1);
            // A pending local call never ran or only read, so the new message replaces it.
            const unanswered = !value.call?.callId
              ? []
              : value.call.state === 'awaiting'
                ? [
                    functionOutput(
                      value.call.callId,
                      'The user did not answer and sent a new message instead.',
                    ),
                  ]
                : value.call.state === 'pending' && value.call.provider === 'local'
                  ? [
                      functionOutput(
                        value.call.callId,
                        'Not finished: the user sent a new message.',
                      ),
                    ]
                  : [];
            return {
              ...value,
              activeMessage: taken.at(-1),
              workStartedAt: value.workStartedAt ?? Date.now(),
              turn:
                value.turn === 'foreground' ||
                taken.some((id) => value.messages.find((m) => m.id === id)?.role === 'user')
                  ? 'foreground'
                  : 'background',
              modelInput: [
                ...(value.modelInput ?? []),
                ...unanswered,
                ...taken.map((id) => {
                  const text = modelMessageText(value.messages.find((m) => m.id === id)!);
                  const pictures = images.get(id);
                  return {
                    role: 'user',
                    content: pictures?.length
                      ? [
                          { type: 'input_text', text },
                          ...pictures.map((url) => ({ type: 'input_image', image_url: url })),
                        ]
                      : text,
                  };
                }),
              ],
              pending: value.pending.filter((id) => !taken.includes(id)),
              messages: value.messages.map((m) =>
                taken.includes(m.id) && m.queue ? { ...m, queue: undefined } : m,
              ),
              call: undefined,
              status: 'running',
              waitingFor: undefined,
              turnUsage: value.activeMessage ? value.turnUsage : undefined,
            };
          });
        }
        const activeMessage = c.messages.find((m) => m.id === c!.activeMessage)!;
        const backgroundTurn = c.turn === 'background';
        const sync = await this.plugins.sync(sources, controller.signal);
        const localWorkspace = ['exec', 'read', 'write', 'edit', 'list'].every(
          (name) => bindings[name]?.provider === 'local',
        );
        skills = [
          ...(localWorkspace ? [builtinSkill] : []),
          ...(await localSkills((await this.workspace).fs)),
          ...sync.skills,
        ];
        if (sync.warnings.length)
          await this.chats.update(id, (value) => ({
            ...value,
            messages: [...value.messages, message('notice', sync.warnings.join('\n'))],
          }));
        const instructions = buildInstructions(
          await this.store.get<string>('memory'),
          bindings,
          skills,
        );
        let result = c.call?.state === 'completed' ? c.call.result : undefined;
        const repeats = new Map<string, number>();
        let overflowRetried = false;
        for (let step = 0; step < maxSteps; step++) {
          this.progress(id, { step: step + 1 });
          const resumed = (await this.store.get<Conversation>(key(id)))?.call;
          // A call the user approved runs as it was proposed, without asking the model again.
          const approved = resumed?.state === 'pending' && resumed.approved ? resumed : undefined;
          let output: ModelStep;
          if (approved)
            output = {
              type: 'tool',
              name: approved.name,
              input: approved.input,
              callId: approved.callId,
            };
          else {
            await this.compactor.compactIfNeeded(id, controller.signal);
            const history = (await this.chats.load(id))?.modelInput;
            try {
              output = await this.requestStep(id, controller.signal, () =>
                this.modelNext(
                  id,
                  {
                    message: activeMessage.text,
                    instructions,
                    tools: Object.keys(bindings).filter((name) => modelVisible(bindings[name])),
                    result,
                    history,
                    definitions: toolDefinitions(bindings),
                    onText: (text) => {
                      this.drafts.set(id, text);
                      this.changed({ type: 'text', conversationId: id, text });
                    },
                    onReasoning: (text) => {
                      this.live.set(id, { step: step + 1, reasoning: text });
                      this.changed({ type: 'reasoning', conversationId: id, text });
                    },
                  },
                  controller.signal,
                ),
              );
            } catch (error) {
              this.drafts.delete(id);
              if (
                !controller.signal.aborted &&
                !isConnectionError(error) &&
                !(error instanceof SignInRequired) &&
                !(error instanceof ContextOverflow) &&
                (await this.compactor.undoServerCompaction(id))
              ) {
                step--;
                continue;
              }
              if (!(error instanceof ContextOverflow)) throw error;
              // One summary and one retry; a second overflow means the current request alone is too large.
              if (overflowRetried || !(await this.compactor.compactInput(id, controller.signal)))
                throw new Error(
                  'This chat no longer fits the model, even after summarising earlier messages. Start a new chat to continue.',
                );
              overflowRetried = true;
              step--;
              continue;
            }
            overflowRetried = false;
            this.drafts.delete(id);
            // Steering received during inference takes precedence over an unexecuted tool
            // or stale answer. The old request remains in model history.
            if (steering(await this.store.get<Conversation>(key(id))).length) {
              await this.chats.update(id, (value) => ({
                ...value,
                activeMessage: undefined,
                call: undefined,
              }));
              break;
            }
          }
          if (output.type === 'text') {
            await this.chats.update(id, (value) => ({
              ...value,
              messages: [
                ...value.messages,
                {
                  ...message('assistant', output.text),
                  durationMs:
                    value.workStartedAt === undefined
                      ? undefined
                      : Math.max(0, Date.now() - value.workStartedAt),
                  usage: value.turnUsage,
                },
              ],
              workStartedAt: undefined,
              turnUsage: undefined,
              retryAt: undefined,
              retryAttempts: undefined,
              turn: undefined,
              modelInput: [...(value.modelInput ?? []), ...(output.items ?? [])],
              activeMessage: undefined,
              call: undefined,
              updatedAt: Date.now(),
            }));
            if (!backgroundTurn || output.text)
              await this.alert(id, output.text.replace(/[#*_`>\[\]]/g, '').slice(0, 200));
            break;
          }
          if (output.type === 'tools') {
            const batch =
              'batch:' + JSON.stringify(output.calls.map(({ name, input }) => [name, input]));
            repeats.set(batch, (repeats.get(batch) ?? 0) + 1);
            if (repeats.get(batch)! > repeatLimit)
              throw new Error(
                `Stopped: the same set of actions was requested ${repeatLimit + 1} times with the same input.`,
              );
            this.progress(id, { step: step + 1, tool: output.calls[0].name });
            result = await this.readOnly.runParallel(
              id,
              output,
              bindings,
              controller.signal,
              backgroundTurn,
            );
            continue;
          }
          const signature = output.name + ':' + JSON.stringify(output.input);
          repeats.set(signature, (repeats.get(signature) ?? 0) + 1);
          if (repeats.get(signature)! > repeatLimit)
            throw new Error(
              `Stopped: the same action (${output.name}) was requested ${repeatLimit + 1} times with the same input.`,
            );
          const called = await this.callTool(
            { id, controller, bindings, pinned, backgroundTurn },
            step,
            output,
            approved,
          );
          if (called === 'paused') return;
          result = called.result;
          if (called.retry) continue;
          // Steering joins at a tool boundary, before any further model/tool calls.
          const latest = await this.store.get<Conversation>(key(id));
          if (steering(latest).length) {
            await this.chats.update(id, (value) => ({
              ...value,
              activeMessage: undefined,
              call: undefined,
            }));
            break;
          }
          if (step === maxSteps - 1)
            throw new Error(
              `Stopped after ${maxSteps} steps. Ask me to continue if more work is needed.`,
            );
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
      if (
        !controller.signal.aborted &&
        (isConnectionError(error) || error instanceof SignInRequired)
      ) {
        await waitForConnection(this.chats, id, error);
        return;
      }
      await this.chats.update(id, (c) => ({
        ...c,
        status: 'stopped',
        workStartedAt: undefined,
        turn: undefined,
        activeMessage: undefined,
        call: undefined,
        plugins: undefined,
        messages: [
          ...c.messages,
          message('notice', controller.signal.aborted ? 'Stopped.' : errorText(error)),
        ],
      }));
    } finally {
      this.drafts.delete(id);
      this.live.delete(id);
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
  /** One tool call: check, journal, ask, run, record. 'paused' ends this run while the turn waits. */
  private async callTool(
    turn: ToolTurn,
    step: number,
    output: ToolStep,
    approved: ToolCall | undefined,
  ): Promise<'paused' | { result: string; retry?: boolean }> {
    const { id, bindings, backgroundTurn } = turn;
    const binding = bindings[output.name];
    const rejected = this.rejection(binding, output);
    // Nothing ran, so the model can correct itself instead of the turn stopping.
    if (rejected)
      return {
        result: await this.recordToolError(id, output, binding?.provider, rejected, backgroundTurn),
        retry: true,
      };
    if (!approved) await this.journal(turn, output, binding);
    const ask = approved ? undefined : this.askFor(output.name, output.input, binding);
    if (ask) {
      // The turn pauses here; answer() resumes it. Nothing has run, so a restart is safe.
      await this.chats.update(id, (value) => ({
        ...value,
        status: 'asking',
        call: { ...value.call!, state: 'awaiting', ask },
      }));
      await this.alert(id, ask.question);
      return 'paused';
    }
    // From here the call may have effects, so a restart must review it, not rerun it.
    if (approved)
      await this.chats.update(id, (value) => ({
        ...value,
        call: { ...value.call!, approved: undefined },
      }));
    this.progress(id, { step: step + 1, tool: output.name });
    try {
      return { result: await this.execute(turn, output, binding) };
    } catch (error) {
      return this.toolFailed(turn, output, binding, error);
    }
  }
  private rejection(binding: Binding | undefined, output: ToolStep): string | undefined {
    if (!binding || !modelVisible(binding)) return 'There is no tool named ' + output.name + '.';
    const validate = this.ajv.compile(binding.tool.inputSchema);
    if (!validate(output.input))
      return 'Invalid tool arguments: ' + this.ajv.errorsText(validate.errors);
  }
  /** Records the call before it runs, so a restart knows it may have happened. */
  private async journal({ id, backgroundTurn }: ToolTurn, output: ToolStep, binding: Binding) {
    await this.chats.update(id, (value) => ({
      ...value,
      modelInput: [...(value.modelInput ?? []), ...(output.items ?? [])],
      messages: output.narration
        ? [
            ...value.messages,
            {
              ...message('assistant', output.narration),
              visibility: backgroundTurn ? 'internal' : undefined,
            },
          ]
        : value.messages,
      retryAt: undefined,
      retryAttempts: undefined,
      call: {
        callId: output.callId,
        id: crypto.randomUUID(),
        name: output.name,
        input: output.input,
        provider: binding.provider,
        state: 'pending',
      },
    }));
  }
  private async execute(
    { id, controller, pinned, backgroundTurn }: ToolTurn,
    output: ToolStep,
    binding: Binding,
  ): Promise<string> {
    const requestedTimeout = binding.tool.timeoutMs ?? 30000;
    // A helper agent makes many model requests; it stops with the turn, not after a minute.
    const timeout =
      output.name === 'delegate'
        ? 600000
        : Number.isFinite(requestedTimeout)
          ? Math.min(60000, Math.max(1000, Math.trunc(requestedTimeout)))
          : 30000;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
    signal.throwIfAborted();
    const response = await abortable(
      binding.tool.execute(output.input, {
        signal,
        checkpoint: async (operationId) => {
          await this.chats.update(id, (value) => ({
            ...value,
            call: value.call ? { ...value.call, operationId } : value.call,
          }));
        },
      }),
      signal,
    );
    const result = printable(response);
    let app: AppView | undefined;
    if (binding.tool.app) {
      try {
        const resource = await binding.tool.app.resource(signal);
        const appId = crypto.randomUUID();
        await this.store.put('app:' + appId, {
          plugins: pinned,
          tool: output.name,
          conversationId: id,
          provider: binding.provider,
        });
        app = { ...resource, id: appId, input: output.input, result: response };
      } catch (error) {
        await this.chats.update(id, (value) => ({
          ...value,
          messages: [
            ...value.messages,
            message('notice', 'Could not load app: ' + errorText(error)),
          ],
        }));
      }
    }
    await this.chats.update(id, (value) => ({
      ...value,
      call: { ...value.call!, state: 'completed', result },
      modelInput: withOutput(value.modelInput, output.callId, result),
      messages: [
        ...value.messages,
        {
          ...message('tool', result, `${output.name} · ${binding.provider}`),
          id: value.call!.id,
          activity: { input: output.input, outcome: toolOutcome(response, binding.tool.command) },
          app,
          file:
            binding.provider === 'local' && output.name === 'show_file'
              ? (response as { file: Message['file'] }).file
              : undefined,
          visibility: backgroundTurn || output.name === 'background' ? 'internal' : undefined,
        },
      ],
    }));
    return result;
  }
  /** A failed call becomes a fact the model can use, a pause until online, or a review stop. */
  private async toolFailed(
    { id, controller, backgroundTurn }: ToolTurn,
    output: ToolStep,
    binding: Binding,
    error: unknown,
  ): Promise<'paused' | { result: string; retry: true }> {
    const call = (await this.store.get<Conversation>(key(id)))?.call;
    const rerunnable = localReadOnly(binding, output.input);
    const offline = isConnectionError(error) || error instanceof SignInRequired;
    if (!controller.signal.aborted && rerunnable && !offline) {
      const result = await this.recordToolError(
        id,
        output,
        binding.provider,
        errorText(error),
        backgroundTurn,
        true,
      );
      return { result, retry: true };
    }
    if (
      !controller.signal.aborted &&
      offline &&
      (rerunnable || (call?.operationId && binding.tool.recover))
    ) {
      await waitForConnection(this.chats, id, error);
      return 'paused';
    }
    await this.chats.update(id, (value) => ({
      ...value,
      status: 'needs_review',
      call: { ...value.call!, state: 'unknown', result: errorText(error) },
      messages: [
        ...value.messages,
        message(
          'notice',
          `Tool outcome needs review: ${errorText(error)}. Changes may already have happened.`,
        ),
      ],
    }));
    if (controller.signal.aborted) await this.requestCancellation(binding, id);
    return 'paused';
  }
  private async alert(id: string, body: string) {
    const c = await this.store.get<Conversation>(key(id));
    try {
      await this.notify({ conversationId: id, title: c?.title || 'Kinetik', body });
    } catch {
      /* A missing notification never affects the work itself. */
    }
  }
  /** The question a call needs answered before it may run, if any. */
  private askFor(name: string, input: Record<string, unknown>, binding: Binding): Ask | undefined {
    if (binding.provider === 'local' && name === 'ask')
      return {
        kind: 'choice',
        question: String(input.question),
        options: (input.options as unknown[]).map(String),
      };
    if (binding.provider === 'local' && name === 'remember')
      return { kind: 'memory', question: 'Save this to your memory?', text: String(input.text) };
    if (needsApproval(binding.tool, input))
      return {
        kind: 'approval',
        question: `Allow Kinetik to run “${name.split('__').at(-1)}”?`,
      };
  }
  /**
   * The user's answer to a paused call. An approval lets the call run; a decline, a choice or a
   * memory decision becomes the call's result. The model continues from there.
   */
  async answer(id: string, value: string): Promise<void> {
    if (typeof value !== 'string' || !value || value.length > 500)
      throw new Error('Invalid answer.');
    const c = await this.store.get<Conversation>(key(id));
    const ask = c?.call?.state === 'awaiting' ? c.call.ask : undefined;
    if (!c || c.status !== 'asking' || !ask) throw new Error('There is no question to answer.');
    if (ask.kind === 'approval' && value === 'approve') {
      await this.chats.update(id, (current) => ({
        ...current,
        status: 'queued',
        call: { ...current.call!, state: 'pending', approved: true, ask: undefined },
      }));
    } else {
      let result: string;
      if (ask.kind === 'approval') result = 'The user declined this action. Do not run it.';
      else if (ask.kind === 'choice') result = 'The user chose: ' + value;
      else {
        if (value === 'save') await this.store.put('memory', ask.text);
        result =
          value === 'save' ? 'The user saved the memory.' : 'The user kept the memory as it was.';
      }
      await this.chats.update(id, (current) => ({
        ...current,
        status: 'queued',
        call: { ...current.call!, state: 'completed', result, ask: undefined },
        modelInput: withOutput(current.modelInput, current.call!.callId, result),
        messages: [
          ...current.messages,
          {
            ...message('tool', result, `${current.call!.name} · ${current.call!.provider}`),
            id: current.call!.id,
            activity: {
              input: current.call!.input,
              outcome: ask.kind === 'approval' ? ('failed' as const) : ('completed' as const),
              returned: ask.kind === 'approval' ? true : undefined,
            },
          },
        ],
      }));
    }
  }
  private async pinFor(id: string) {
    const c = await this.store.get<Conversation>(key(id));
    return c?.workStartedAt !== undefined ? c.turnModel : await this.model.pin?.();
  }
  /** A model request with the provider and model pinned for this conversation's turn. */
  private async modelNext(id: string, request: ModelRequest, signal: AbortSignal) {
    return this.model.next({ ...request, pin: await this.pinFor(id) }, signal);
  }
  /** Runs one model request and records its token usage on the conversation. */
  private async requestStep(
    id: string,
    signal: AbortSignal,
    request: () => Promise<ModelStep>,
  ): Promise<ModelStep> {
    const output = await abortable(request(), signal);
    const c = await this.chats.load(id);
    const window = output.contextWindow ?? c?.context?.window ?? defaultContextWindow;
    const tokens = output.usage
      ? output.usage.input + output.usage.output
      : estimateTokens(c?.modelInput) + estimateTokens(output.items);
    await this.chats.update(id, (value) => ({
      ...value,
      context: { tokens, window },
      turnUsage: addUsage(value.turnUsage, output.usage),
      // A request that worked accepts any provider compaction before it.
      serverCompaction: undefined,
    }));
    return output;
  }
  /** Records a tool call that failed without uncertain effects and hands the error to the model. */
  private async recordToolError(
    id: string,
    output: Extract<ModelStep, { type: 'tool' }>,
    provider: string | undefined,
    error: string,
    backgroundTurn: boolean,
    ran = false,
  ): Promise<string> {
    const text = 'Error: ' + error;
    await this.chats.update(id, (value) => ({
      ...value,
      modelInput: [
        ...(value.modelInput ?? []),
        ...(ran ? [] : (output.items ?? [])),
        ...(output.callId ? [functionOutput(output.callId, text)] : []),
      ],
      call: ran ? { ...value.call!, state: 'completed', result: text } : undefined,
      messages: [
        ...value.messages,
        ...(!ran && output.narration
          ? [
              {
                ...message('assistant', output.narration),
                visibility: backgroundTurn ? ('internal' as const) : undefined,
              },
            ]
          : []),
        {
          ...message('tool', text, `${output.name} · ${provider ?? 'unknown'}`),
          ...(ran ? { id: value.call!.id } : {}),
          activity: { input: output.input, outcome: 'failed' as const, returned: true },
          visibility: backgroundTurn ? ('internal' as const) : undefined,
        },
      ],
    }));
    return text;
  }
  /** On-demand compaction, outside a running turn. */
  async compact(id: string): Promise<void> {
    if (this.active.has(id))
      throw new Error('Wait until the current work finishes, then try again.');
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (!(await this.compactor.compactInput(id, controller.signal)))
        await this.chats.update(id, (value) => ({
          ...value,
          messages: [...value.messages, message('notice', 'Nothing to summarise yet.')],
        }));
    } finally {
      this.active.delete(id);
    }
  }
  private async requestCancellation(binding: Binding, id: string): Promise<void> {
    const c = await this.store.get<Conversation>(key(id));
    if (c?.call?.operationId && binding.tool.cancel) {
      try {
        await binding.tool.cancel(c.call.operationId);
      } catch {
        await this.chats.update(id, (value) => ({
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
    await this.chats.update(id, (c) => ({
      ...c,
      status: c.status === 'needs_review' ? c.status : 'stopped',
      pending: [],
      messages: c.messages.map((m) =>
        c.pending.includes(m.id) ? { ...m, queue: undefined, unsent: true } : m,
      ),
      workStartedAt: undefined,
    }));
    await this.background.cancelConversation(id);
  }
  private recovery?: Promise<void>;
  private prepared?: Promise<void>;
  /** Migrates and cleans storage once per worker, before any recovery. */
  private prepare() {
    // A failed migration is retried on the next start; a failed sweep only leaves garbage.
    return (this.prepared ??= migrate({
      store: this.store,
      chats: this.chats,
      plugins: this.plugins,
    })
      .then(() => sweepDaily(this.store))
      .catch(() => {}));
  }
  recover(): Promise<void> {
    return (this.recovery ??= this.prepare()
      .then(() =>
        recoverWork({
          store: this.store,
          chats: this.chats,
          plugins: this.plugins,
          apps: this.apps,
          background: this.background,
          active: this.active,
          conversations: () => this.conversations(),
          localTools: async () =>
            localTools(await this.workspace, () => [builtinSkill], this.store),
        }),
      )
      .finally(() => {
        this.recovery = undefined;
      }));
  }
  async deleteConversation(id: string): Promise<void> {
    this.active.get(id)?.abort(new Error('Chat deleted'));
    await this.background.cancelConversation(id);
    const keys = await conversationKeys(this.store, id);
    await this.store.updateMany([], () => keys.map((key) => [key, undefined]));
    this.changed();
  }
  async resolve(id: string, retry: boolean): Promise<void> {
    await this.chats.update(id, (c) => {
      if (c.status !== 'needs_review' || !c.call)
        throw new Error('No uncertain tool call to resolve.');
      return {
        ...c,
        status: 'queued',
        modelInput: withOutput(
          c.modelInput,
          c.call.callId,
          retry
            ? 'User requested retry of this call.'
            : 'User resolved this uncertain outcome without retrying. Do not repeat it.',
        ),
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
  files() {
    return this.workspaceFiles.list();
  }
  readMonitor(path: string) {
    return this.workspaceFiles.readMonitor(path);
  }
  appCall(id: string, name: string, input: Record<string, unknown>, approved = false) {
    return this.apps.call(id, name, input, approved);
  }
  appNeedsApproval(id: string, name: string, input: Record<string, unknown>) {
    return this.apps.needsApproval(id, name, input);
  }
  importFile(name: string, bytes: Uint8Array) {
    return this.workspaceFiles.importFile(name, bytes);
  }
  exportSharedFile(id: string) {
    return this.workspaceFiles.exportSharedFile(id);
  }
  exportFile(path: string) {
    return this.workspaceFiles.exportFile(path);
  }
}
