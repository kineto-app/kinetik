import { Store } from '../browser/store';
import { openCall } from './turn';
import { errorText, type Binding, type Conversation } from './types';

export interface Automation {
  id: string;
  kind: 'task' | 'goal' | 'job' | 'monitor';
  prompt: string;
  status: 'active' | 'paused' | 'completed';
  intervalMs?: number;
  event?: string;
  nextAt: number;
  maxRuns: number;
  runs: number;
  conversationId?: string;
  lastConversationId?: string;
  lastResult?: string;
  watchPath?: string;
  fingerprint?: string;
  pendingChange?: string;
  lastError?: string;
}
interface EventRecord {
  id: string;
  name: string;
  text: string;
  targets: string[];
}
interface State {
  items: Automation[];
  events: EventRecord[];
  seen: string[];
}
const empty = (): State => ({ items: [], events: [], seen: [] });
export interface AutomationHost {
  ensureConversation(id: string): Promise<Conversation>;
  submit(id: string, text: string, messageId?: string): Promise<void>;
  run(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  readMonitor(path: string): Promise<string>;
}

/** Durable scheduling. Browser wakeups drive tick; a timer is never the record of a job. */
export class Automations {
  constructor(
    private store: Store,
    private host: AutomationHost,
    private changed: () => void,
  ) {}
  async list() {
    return ((await this.store.get<State>('automations')) ?? empty()).items;
  }
  async create(input: Record<string, unknown>): Promise<Automation> {
    const kind = input.kind as Automation['kind'];
    if (!['task', 'goal', 'job', 'monitor'].includes(kind))
      throw new Error('Choose task, goal, job, or monitor.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000)
      throw new Error('Enter a prompt up to 12,000 characters.');
    const intervalMs = input.intervalMs === undefined ? undefined : Number(input.intervalMs);
    const event = input.event === undefined || input.event === '' ? undefined : String(input.event);
    if (event && !/^[\w.-]{1,100}$/.test(event))
      throw new Error('Use a short event name with letters, digits, dots, or dashes.');
    if (intervalMs !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs < 60000))
      throw new Error('Intervals must be at least one minute.');
    if (['job', 'monitor'].includes(kind) && !intervalMs && !event)
      throw new Error('A routine needs an interval or event.');
    const watchPath = typeof input.watchPath === 'string' ? input.watchPath : undefined;
    if (kind === 'monitor' && (!watchPath || watchPath.length > 1024 || !intervalMs))
      throw new Error(
        'A monitor needs a file path and interval. It triggers when the file changes.',
      );
    const maxRuns = Number(input.maxRuns ?? (kind === 'task' ? 1 : 10));
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000)
      throw new Error('Run limit must be 1–1000.');
    const item: Automation = {
      watchPath,
      id: crypto.randomUUID(),
      kind,
      prompt: input.prompt,
      intervalMs,
      event,
      nextAt: event && !intervalMs ? Number.MAX_SAFE_INTEGER : Date.now(),
      status: 'active',
      maxRuns,
      runs: 0,
    };
    await this.store.update<State>('automations', (previous) => {
      const state = previous ?? empty();
      if (state.items.length >= 100) throw new Error('Maximum 100 automations.');
      return { ...state, items: [...state.items, item] };
    });
    this.changed();
    return item;
  }
  async setStatus(id: string, status: Automation['status'], cancel = true) {
    if (!['active', 'paused', 'completed'].includes(status)) throw new Error('Invalid status.');
    const item = (await this.list()).find((item) => item.id === id);
    const conversation = item?.conversationId
      ? await this.store.get<Conversation>('conversation:' + item.conversationId)
      : undefined;
    if (
      status === 'active' &&
      (conversation?.status === 'needs_review' || openCall(conversation?.turn?.call))
    )
      throw new Error('Review the interrupted tool in its conversation before resuming.');
    let conversationId: string | undefined;
    await this.store.update<State>('automations', (previous) => {
      const state = previous ?? empty();
      if (!state.items.some((item) => item.id === id)) throw new Error('Automation not found.');
      return {
        ...state,
        items: state.items.map((item) => {
          if (item.id !== id) return item;
          conversationId = item.conversationId;
          return status === 'active' && conversation?.status === 'stopped'
            ? {
                ...item,
                status,
                conversationId: undefined,
                lastConversationId: item.conversationId,
                nextAt: Date.now(),
              }
            : { ...item, status };
        }),
      };
    });
    if (cancel && status !== 'active' && conversationId) await this.host.stop(conversationId);
    this.changed();
  }
  async remove(id: string, cancel = true) {
    await this.setStatus(id, 'paused', cancel);
    await this.store.update<State>('automations', (previous) => ({
      ...previous!,
      items: previous!.items.filter((item) => item.id !== id),
      events: previous!.events
        .map((event) => ({ ...event, targets: event.targets.filter((target) => target !== id) }))
        .filter((event) => event.targets.length),
    }));
    this.changed();
  }
  async emit(name: string, text: string, id: string = crypto.randomUUID()) {
    if (
      !/^[\w.-]{1,100}$/.test(name) ||
      typeof text !== 'string' ||
      text.length > 12000 ||
      typeof id !== 'string' ||
      id.length > 200
    )
      throw new Error('Invalid event.');
    await this.store.update<State>('automations', (previous) => {
      const state = previous ?? empty();
      if (state.seen.includes(id)) return state;
      if (state.events.length >= 100) throw new Error('Event queue is full.');
      return {
        ...state,
        events: [
          ...state.events,
          {
            id,
            name,
            text,
            targets: state.items
              .filter((item) => item.status === 'active' && item.event === name)
              .map((item) => item.id),
          },
        ].filter((event) => event.targets.length),
        seen: [...state.seen, id].slice(-1000),
      };
    });
    this.changed();
  }
  async tick(now = Date.now()) {
    const tick = async () => {
      // A dispatch remains stored until its conversation completes. After a crash, the
      // deterministic conversation and message IDs resume it without submitting twice.
      let state = (await this.store.get<State>('automations')) ?? empty();
      for (const item of state.items.filter(
        (item) => item.status === 'active' && item.conversationId,
      )) {
        const conversation = await this.store.get<Conversation>(
          'conversation:' + item.conversationId,
        );
        if (conversation?.status === 'stopped' || conversation?.status === 'needs_review') {
          await this.store.update<State>('automations', (previous) => ({
            ...previous!,
            items: previous!.items.map((current) =>
              current.id === item.id ? { ...current, status: 'paused' } : current,
            ),
          }));
        }
        if (conversation?.status === 'idle' && conversation.messages.length) {
          const background = await this.store.entries<{
            conversationId: string;
            state: string;
            delivered?: boolean;
          }>('background:');
          if (
            background.some(
              ([, job]) =>
                job.conversationId === item.conversationId &&
                (job.state === 'running' || !job.delivered),
            )
          )
            continue;
          await this.store.update<State>('automations', (previous) => ({
            ...previous!,
            items: previous!.items.map((current) =>
              current.id === item.id
                ? {
                    ...current,
                    conversationId: undefined,
                    lastConversationId: item.conversationId,
                    lastResult: conversation.messages
                      .filter((m) => m.role === 'assistant')
                      .at(-1)
                      ?.text.slice(0, 4000),
                    status:
                      current.kind === 'task' || current.runs >= current.maxRuns
                        ? 'completed'
                        : current.status,
                    nextAt: current.intervalMs
                      ? now + current.intervalMs
                      : current.kind === 'goal'
                        ? now
                        : Number.MAX_SAFE_INTEGER,
                  }
                : current,
            ),
          }));
        }
      }
      for (const item of state.items.filter(
        (item) =>
          item.kind === 'monitor' &&
          item.status === 'active' &&
          !item.conversationId &&
          item.nextAt <= now,
      )) {
        try {
          const content = await this.host.readMonitor(item.watchPath!);
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
          const fingerprint = Array.from(new Uint8Array(hash)).join(',');
          const change =
            item.fingerprint !== undefined && item.fingerprint !== fingerprint
              ? 'File changed: ' + item.watchPath + '\n' + content.slice(0, 2000)
              : undefined;
          await this.store.update<State>('automations', (previous) => ({
            ...previous!,
            items: previous!.items.map((current) =>
              current.id === item.id
                ? {
                    ...current,
                    fingerprint,
                    lastError: undefined,
                    pendingChange: change ?? current.pendingChange,
                    nextAt: now + current.intervalMs!,
                  }
                : current,
            ),
          }));
        } catch (error) {
          // A transient outage is not a change. Retry at the next interval.
          await this.store.update<State>('automations', (previous) => ({
            ...previous!,
            items: previous!.items.map((current) =>
              current.id === item.id
                ? { ...current, lastError: errorText(error), nextAt: now + current.intervalMs! }
                : current,
            ),
          }));
        }
      }
      state = await this.store.update<State>('automations', (previous) => {
        const current = previous ?? empty();
        const consumed = new Map<string, Set<string>>();
        const items = current.items.map((item) => {
          if (item.status !== 'active' || item.conversationId) return item;
          if (item.runs >= item.maxRuns) return { ...item, status: 'completed' as const };
          const matching = current.events.find((e) => e.targets.includes(item.id));
          if (item.kind === 'monitor' ? !item.pendingChange : !matching && item.nextAt > now)
            return item;
          if (matching) {
            if (!consumed.has(matching.id)) consumed.set(matching.id, new Set());
            consumed.get(matching.id)!.add(item.id);
          }
          // The trigger payload is persisted with the dispatch, not kept just in memory.
          const dispatched = {
            ...item,
            runs: item.runs + 1,
            conversationId: `automation-${item.id}-${item.runs + 1}`,
          };
          return {
            ...dispatched,
            trigger: item.pendingChange ?? matching?.text,
            pendingChange: undefined,
          };
        });
        const events = current.events
          .map((event) => ({
            ...event,
            targets: event.targets.filter(
              (id) =>
                !consumed.get(event.id)?.has(id) &&
                items.some((item) => item.id === id && item.status !== 'completed'),
            ),
          }))
          .filter((event) => event.targets.length);
        return { ...current, items, events };
      });
      const dispatched = state.items.filter(
        (item) => item.status === 'active' && item.conversationId,
      );
      await Promise.all(
        dispatched.map(async (item) => {
          const id = item.conversationId!;
          await this.host.ensureConversation(id);
          const trigger = (item as Automation & { trigger?: string }).trigger;
          const instruction =
            item.kind === 'goal'
              ? `Work toward this goal. This is run ${item.runs}/${item.maxRuns}. When achieved, call automation with action status, id ${item.id}, status completed.\n`
              : item.kind === 'monitor'
                ? 'Check the condition described below. Report only useful findings and use prior run history when available.\n'
                : '';
          await this.host.submit(
            id,
            instruction +
              item.prompt +
              (item.lastResult ? '\nPrevious run result:\n' + item.lastResult : '') +
              (trigger ? '\nEvent:\n' + trigger : ''),
            id + '-trigger',
          );
        }),
      );
      this.changed();
      return dispatched.map((item) => item.conversationId!);
    };
    const ids = globalThis.navigator?.locks
      ? await navigator.locks.request('kinetik-automations', tick)
      : await tick();
    await Promise.all(ids.map((id) => this.host.run(id)));
  }
  binding(): Binding {
    return {
      provider: 'local',
      tool: {
        description:
          'Manage background tasks, goals, jobs and monitors. They run when the browser is awake; missed intervals coalesce. Creation requires a prompt and an explicit run limit. Use list to inspect results via conversationId. Events trigger matching routines.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'status', 'emit', 'remove'] },
            kind: { type: 'string', enum: ['task', 'goal', 'job', 'monitor'] },
            prompt: { type: 'string' },
            intervalMs: { type: 'integer', minimum: 60000 },
            event: { type: 'string' },
            watchPath: { type: 'string' },
            maxRuns: { type: 'integer', minimum: 1, maximum: 1000 },
            id: { type: 'string' },
            status: { type: 'string', enum: ['active', 'paused', 'completed'] },
            text: { type: 'string' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        execute: async (input) => {
          switch (input.action) {
            case 'list':
              return this.list();
            case 'create':
              return this.create(input);
            case 'status':
              await this.setStatus(String(input.id), input.status as Automation['status'], false);
              return 'Updated';
            case 'remove':
              await this.remove(String(input.id), false);
              return 'Removed';
            case 'emit':
              await this.emit(
                String(input.event),
                String(input.text ?? ''),
                input.id as string | undefined,
              );
              return 'Queued';
            default:
              throw new Error('Unknown automation action.');
          }
        },
      },
    };
  }
}
