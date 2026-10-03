import type { Store } from '../browser/store';
import type { Plugins } from '../plugins/loader';
import { abortable } from './abortable';
import type { AppCalls } from './apps';
import type { BackgroundProcess, BackgroundProcesses } from './background';
import { isConnectionError, SignInRequired } from './connection-error';
import { conversationKey as key, type ConversationStore } from './conversation-store';
import { printable, withOutput } from './model-input';
import { localReadOnly } from './read-only';
import { toolOutcome } from './tool-outcome';
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
    if (
      !['running', 'queued', 'waiting'].includes(c.status) &&
      !(c.status === 'stopped' && c.call?.state === 'pending')
    )
      continue;
    const recover = async () => {
      if (
        c.call?.state === 'pending' &&
        c.call.provider === 'local' &&
        localReadOnly(local[c.call.name], c.call.input) &&
        !c.call.approved
      ) {
        // It changed nothing, so running it again is safe; the approved path runs it as proposed.
        await chats.update(c.id, (value) => ({
          ...value,
          status: value.status === 'stopped' ? 'stopped' : 'queued',
          call: { ...value.call!, approved: true },
        }));
        return;
      }
      if (c.call?.state === 'pending' && c.call.approved) {
        // Approved but never started: running it now is its first and only run.
        if (c.status !== 'stopped')
          await chats.update(c.id, (value) => ({ ...value, status: 'queued' }));
        return;
      }
      if (c.call?.state === 'pending') {
        // A crash between starting a job and saving its receipt must not start it twice.
        const job =
          c.call.name === 'background'
            ? await store.get<BackgroundProcess>('background:' + c.call.id)
            : undefined;
        if (job) {
          const result = JSON.stringify({ id: job.id, state: job.state });
          await chats.update(c.id, (value) => ({
            ...value,
            status: c.status === 'stopped' ? 'stopped' : 'queued',
            call: { ...value.call!, state: 'completed', result },
            modelInput: withOutput(value.modelInput, value.call?.callId, result),
          }));
          return;
        }
        try {
          const snapshot = await plugins.snapshot(local, c.plugins ?? []);
          const tool = snapshot.bindings[c.call.name]?.tool;
          if (c.status !== 'stopped' && tool?.recover && c.call.operationId) {
            const signal = AbortSignal.timeout(10000);
            let status;
            try {
              status = await abortable(tool.recover(c.call.operationId, signal), signal);
            } catch (error) {
              if (isConnectionError(error) || error instanceof SignInRequired) {
                await waitForConnection(chats, c.id, error);
                return;
              }
              throw error;
            }
            if (status.done) {
              await chats.update(c.id, (value) => ({
                ...value,
                status: value.status === 'stopped' ? 'stopped' : 'queued',
                retryAt: undefined,
                retryAttempts: undefined,
                waitingFor: undefined,
                messages: [
                  ...value.messages,
                  {
                    ...message(
                      'tool',
                      printable(status.result),
                      `${value.call!.name} · ${value.call!.provider}`,
                    ),
                    id: value.call!.id,
                    activity: {
                      input: value.call!.input,
                      outcome: toolOutcome(status.result, tool.command),
                    },
                    visibility: value.turn === 'background' ? 'internal' : undefined,
                  },
                ],
                call: { ...value.call!, state: 'completed', result: printable(status.result) },
                modelInput: withOutput(
                  value.modelInput,
                  value.call?.callId,
                  printable(status.result),
                ),
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
      } else await chats.update(c.id, (value) => ({ ...value, status: 'queued' }));
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
