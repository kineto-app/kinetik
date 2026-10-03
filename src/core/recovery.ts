import type { Store } from './ports';
import type { Plugins } from '../plugins/loader';
import { abortable } from './abortable';
import type { AppCalls } from './apps';
import type { BackgroundProcess, BackgroundProcesses } from './background';
import { isConnectionError, SignInRequired } from './connection-error';
import { conversationKey as key, type ConversationStore } from './conversation-store';
import { printable, withOutput } from './model-input';
import { localReadOnly } from './read-only';
import { toolOutcome } from './tool-outcome';
import { openCall, withCall } from './turn';
import { message, type Binding, type Conversation } from './types';

/** Pauses a turn until the connection or sign-in is back; a stopped or reviewed turn stays put. */
export function waitForConnection(chats: ConversationStore, id: string, error?: unknown) {
  return chats.update(id, (c) =>
    c.status === 'stopped' || c.status === 'needs_review'
      ? c
      : {
          ...c,
          status: 'waiting',
          waitingFor: error instanceof SignInRequired ? 'signin' : 'connection',
          retryAttempts: error instanceof SignInRequired ? undefined : (c.retryAttempts ?? 0) + 1,
          retryAt:
            error instanceof SignInRequired
              ? undefined
              : Date.now() + Math.min(30000, 2000 * 2 ** Math.min(c.retryAttempts ?? 0, 4)),
        },
  );
}

type RecoveryDeps = {
  store: Store;
  chats: ConversationStore;
  plugins: Plugins;
  apps: AppCalls;
  background: BackgroundProcesses;
  /** Turns running in this worker; a restart only recovers the others. */
  active: Map<string, unknown>;
  conversations: () => Promise<Conversation[]>;
  localTools: () => Promise<Record<string, Binding>>;
};

/** Puts work a dead worker left behind back on a safe path: run, wait, or ask the user. */
export async function recoverWork(deps: RecoveryDeps): Promise<void> {
  const { store, chats, plugins, apps, background } = deps;
  for (const [callKey, call] of await store.entries<{
    state: string;
    conversationId: string;
    name: string;
  }>('app-call:')) {
    if (call.state !== 'pending' || apps.running(callKey)) continue;
    if (await store.get(key(call.conversationId)))
      await chats.update(call.conversationId, (value) => ({
        ...value,
        messages: [
          ...value.messages,
          message(
            'notice',
            `The worker stopped during app tool ${call.name}. Check its effects before trying again.`,
          ),
        ],
      }));
    await store.put(callKey, { ...call, state: 'unknown' });
  }
  const local = await deps.localTools();
  for (const c of await deps.conversations()) {
    if (deps.active.has(c.id)) continue;
    const call = c.turn?.call;
    if (
      !['running', 'queued', 'waiting'].includes(c.status) &&
      !(c.status === 'stopped' && openCall(call))
    )
      continue;
    const recover = async () => {
      if (call?.state === 'proposed' || call?.state === 'approved') {
        // Never started: running it now is its first and only run. A proposed call still asks.
        if (c.status !== 'stopped')
          await chats.update(c.id, (value) => ({ ...value, status: 'queued' }));
        return;
      }
      if (call?.state !== 'started') {
        await chats.update(c.id, (value) => ({ ...value, status: 'queued' }));
        return;
      }
      if (call.provider === 'local' && localReadOnly(local[call.name], call.input)) {
        // It changed nothing, so running it again is safe.
        await chats.update(c.id, (value) => ({
          ...withCall(value, { state: 'approved' }),
          status: value.status === 'stopped' ? 'stopped' : 'queued',
        }));
        return;
      }
      // A crash between starting a job and saving its receipt must not start it twice.
      const job =
        call.name === 'background'
          ? await store.get<BackgroundProcess>('background:' + call.id)
          : undefined;
      if (job) {
        const result = JSON.stringify({ id: job.id, state: job.state });
        await chats.update(c.id, (value) => ({
          ...withCall(value, { state: 'completed', result }),
          status: c.status === 'stopped' ? 'stopped' : 'queued',
          modelInput: withOutput(value.modelInput, call.callId, result),
        }));
        return;
      }
      try {
        const snapshot = await plugins.snapshot(local, c.plugins ?? []);
        const tool = snapshot.bindings[call.name]?.tool;
        if (c.status !== 'stopped' && tool?.recover && call.operationId) {
          const signal = AbortSignal.timeout(10000);
          let status;
          try {
            status = await abortable(tool.recover(call.operationId, signal), signal);
          } catch (error) {
            if (isConnectionError(error) || error instanceof SignInRequired) {
              await waitForConnection(chats, c.id, error);
              return;
            }
            throw error;
          }
          if (status.done) {
            const result = printable(status.result);
            await chats.update(c.id, (value) => ({
              ...withCall(value, { state: 'completed', result }),
              status: value.status === 'stopped' ? 'stopped' : 'queued',
              retryAt: undefined,
              retryAttempts: undefined,
              waitingFor: undefined,
              messages: [
                ...value.messages,
                {
                  ...message('tool', result, `${call.name} · ${call.provider}`),
                  id: call.id,
                  activity: {
                    input: call.input,
                    outcome: toolOutcome(status.result, tool.command),
                  },
                  visibility: value.turn?.kind === 'background' ? 'internal' : undefined,
                },
              ],
              modelInput: withOutput(value.modelInput, call.callId, result),
            }));
            return;
          }
          // The saved operation is still running. Check it again, never re-execute it.
          await waitForConnection(chats, c.id);
          return;
        }
      } catch {
        /* Unavailable plugins or reconciliation failures leave an explicit unknown outcome. */
      }
      await chats.update(c.id, (value) => ({
        ...withCall(value, { state: 'unknown' }),
        status: 'needs_review',
        messages: [
          ...value.messages,
          message(
            'notice',
            'The worker stopped during a tool call. Review its outcome before continuing.',
          ),
        ],
      }));
    };
    if (globalThis.navigator?.locks)
      await navigator.locks.request(
        'kinetik-conversation:' + c.id,
        { ifAvailable: true },
        (lock) => (lock ? recover() : undefined),
      );
    else await recover();
  }
  await background.recover();
}
