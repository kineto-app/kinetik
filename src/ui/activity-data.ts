import type { Message } from '../core/types';
import { toolOutcome } from '../core/tool-outcome';
import { taskAction, taskKind, taskLabel } from './task-labels';

export interface Activity {
  message: Message;
  outcome: NonNullable<Message['activity']>['outcome'];
  recovered: boolean;
}
export interface ActivityBatch {
  key: string;
  items: Activity[];
  label: string;
  failed: boolean;
  running: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
function provider(message: Message) {
  const [name, source] = (message.tool ?? '').split(' · ');
  return name === 'App' ? 'App' : (source ?? name.split('__')[0]);
}
function outcome(message: Message): Activity['outcome'] {
  if (message.activity) return message.activity.outcome;
  // Old conversations did not retain arguments or status. Only inspect known envelopes.
  const kind = taskKind(message.tool ?? '');
  if (provider(message) !== 'local') {
    try {
      const result = JSON.parse(message.text);
      if (
        result &&
        typeof result === 'object' &&
        ('isError' in result || 'structuredContent' in result)
      )
        return toolOutcome(result, kind === 'exec');
    } catch {
      /* Legacy plain-text receipt. */
    }
  }
  return toolOutcome(message.text, kind === 'exec');
}

/** Group only the messages between narration boundaries. Never infer retry success from a title. */
export function activityBatches(messages: Message[]): ActivityBatch[] {
  const succeeded = new Set<string>();
  const activities: Activity[] = [];
  for (const message of [...messages].reverse()) {
    const state = outcome(message);
    const identity = message.activity
      ? provider(message) +
        ':' +
        taskKind(message.tool ?? '') +
        ':' +
        stable(message.activity.input)
      : undefined;
    const recovered = state === 'failed' && identity !== undefined && succeeded.has(identity);
    if (state === 'completed' && identity !== undefined) succeeded.add(identity);
    activities.unshift({ message, outcome: state, recovered });
  }
  const batches = new Map<string, ActivityBatch>();
  for (const item of activities) {
    const key = provider(item.message) + ':' + taskKind(item.message.tool ?? '');
    const batch = batches.get(key) ?? { key, items: [], label: '', failed: false, running: false };
    batch.items.push(item);
    batch.failed ||= !item.recovered && ['failed', 'unknown'].includes(item.outcome);
    batch.running ||= item.outcome === 'running';
    batches.set(key, batch);
  }
  for (const batch of batches.values()) {
    const successful = batch.items.filter((item) => item.outcome === 'completed');
    const kind = taskKind(batch.items[0].message.tool ?? '');
    // Count files, not duplicate reads of the same file or failed retry attempts.
    const count = ['read', 'write', 'edit'].includes(kind)
      ? new Set(successful.map(({ message }) => message.activity?.input.path ?? message.id)).size
      : successful.length;
    batch.label =
      batch.items.some((item) => item.outcome === 'started') && !batch.failed && !batch.running
        ? 'Started background work'
        : batch.failed
          ? taskAction(batch.items[0].message.tool ?? '')
          : taskLabel(batch.items[0].message.tool ?? '', !batch.running, count);
    if (
      !batch.failed &&
      !batch.running &&
      count > 1 &&
      ['read', 'write', 'edit'].includes(kind) &&
      successful.some(({ message }) => typeof message.activity?.input.path !== 'string')
    ) {
      batch.label =
        kind === 'read' ? 'Read files' : kind === 'write' ? 'Saved files' : 'Updated files';
    }
  }
  return [...batches.values()];
}

export function activityTitle(item: Activity): string {
  if (item.outcome === 'started') return 'Started background work';
  const name = item.message.tool ?? '';
  const input = item.message.activity?.input ?? {};
  const kind = taskKind(name);
  const complete = item.outcome === 'completed';
  const path = typeof input.path === 'string' ? input.path.split('/').filter(Boolean) : [];
  const filename = path.at(-1);
  if (filename && ['read', 'write', 'edit'].includes(kind)) {
    const verb =
      kind === 'read'
        ? 'Read'
        : kind === 'write'
          ? complete
            ? 'Saved'
            : 'Save'
          : complete
            ? 'Updated'
            : 'Update';
    return `${verb} ${filename}`;
  }
  if (kind === 'read_skill' && filename) return `Read ${path.at(-2) ?? filename} instructions`;
  if (kind === 'exec' && typeof input.command === 'string') {
    const command = input.command.trim().match(/^[a-zA-Z][\w.-]{0,31}(?=\s|$)/)?.[0];
    if (command)
      return `${complete ? 'Ran' : item.outcome === 'running' ? 'Running' : 'Run'} ${command}`;
  }
  return ['failed', 'unknown'].includes(item.outcome)
    ? taskAction(name)
    : taskLabel(name, complete);
}

export function activityExplanation(item: Activity): string {
  if (item.recovered) return 'This attempt failed. A later retry of the same action succeeded.';
  if (item.outcome === 'failed') return 'This action did not finish successfully.';
  if (item.outcome === 'unknown')
    return 'The result could not be confirmed. Review it before retrying.';
  if (item.outcome === 'started') return 'The command was started in the background.';
  if (item.outcome === 'running') return 'The command started and is still running.';
  const input = item.message.activity?.input ?? {};
  const path =
    typeof input.path === 'string' ? input.path.split('/').filter(Boolean).at(-1) : undefined;
  const file = path ? `“${path}”` : 'the file';
  switch (taskKind(item.message.tool ?? '')) {
    case 'read':
      return `Read ${file}.`;
    case 'write':
      return `Saved ${file}.`;
    case 'edit':
      return `Updated ${file}.`;
    case 'read_skill':
      return 'Read the instructions for this task.';
    case 'find_skill':
      return 'Looked up available instructions.';
    case 'list':
      return 'Checked the files in this folder.';
    case 'exec':
      return 'The command finished successfully.';
    case 'render':
      return item.message.app
        ? 'Prepared the interactive preview shown in chat.'
        : 'Prepared a preview.';
    case 'job':
      return 'Retrieved the latest status of background work.';
    default:
      return 'The tool returned a result. Open technical details to inspect it.';
  }
}

/** MCP text blocks can themselves contain serialized JSON. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try {
        return JSON.stringify(redact(JSON.parse(value)));
      } catch {
        /* Plain text. */
      }
    }
    return value.replace(/([?&](?:[\w-]*token|code|api[_-]?key)=)[^&\s"<>]+/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:[\w-]*token|authorization|password|secret|api[_-]?key)$/i.test(key)
          ? '[redacted]'
          : redact(item),
      ]),
    );
  return value;
}

export function technicalDetails(message: Message): string {
  let result: unknown = message.text;
  try {
    result = JSON.parse(message.text);
  } catch {
    /* Text output. */
  }
  const safe = redact(result);
  return (
    (message.tool ?? 'Tool') +
    '\n\n' +
    (message.activity
      ? 'Input\n' + JSON.stringify(redact(message.activity.input), null, 2) + '\n\nResult\n'
      : '') +
    (typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2))
  );
}
