import type { Conversation, RunStatus, ToolCall, Turn } from './types';

/** Clears what belongs to one turn. Pinned plugins stay until the chat goes idle. */
export const endTurn = (c: Conversation, status: RunStatus): Conversation => ({
  ...c,
  status,
  turn: undefined,
  retryAt: undefined,
  retryAttempts: undefined,
  waitingFor: undefined,
});

export const withTurn = (c: Conversation, change: Partial<Turn>): Conversation => ({
  ...c,
  turn: { ...c.turn, ...change },
});

/** Changes the turn's current call; `undefined` drops it. */
export const withCall = (c: Conversation, change: Partial<ToolCall> | undefined): Conversation =>
  withTurn(c, { call: change && ({ ...c.turn?.call, ...change } as ToolCall) });

/** A call that has not produced its outcome yet. */
export const openCall = (call: ToolCall | undefined) =>
  call && ['proposed', 'approved', 'started'].includes(call.state) ? call : undefined;
