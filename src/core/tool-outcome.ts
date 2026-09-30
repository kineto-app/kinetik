import type { Message } from './types';

type Outcome = NonNullable<Message['activity']>['outcome'];

/** Inspect protocol status, never words such as "error" in file contents or stdout. */
export function toolOutcome(result: unknown, command = false): Outcome {
  if (typeof result === 'string') {
    return command && /\nExit code: [1-9]\d*\s*$/.test(result) ? 'failed' : 'completed';
  }
  if (!result || typeof result !== 'object') return 'completed';
  const envelope = result as Record<string, unknown>;
  if (envelope.isError === true) return 'failed';
  let data = envelope.structuredContent ?? envelope;
  if (!envelope.structuredContent && Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item?.type === 'text')?.text;
    try {
      data = JSON.parse(text);
    } catch {
      // Plain text MCP results have no additional structured status.
    }
  }
  if (!data || typeof data !== 'object') return 'completed';
  const status = data as Record<string, unknown>;
  if (['failed', 'error', 'cancelled', 'canceled'].includes(String(status.status))) return 'failed';
  if (command) {
    const code = status.exit_code ?? status.exitCode;
    if (typeof code === 'number' && code !== 0) return 'failed';
    if (['running', 'pending'].includes(String(status.status))) return 'started';
  }
  return 'completed';
}
