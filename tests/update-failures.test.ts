import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { RuntimeHost, type HostReply } from '../src/core/host';
import { protocolVersion } from '../src/core/protocol';
import {
  ConnectionError,
  ModelRejected,
  OperationFailure,
  failureKind,
} from '../src/core/connection-error';
import type { Conversation } from '../src/core/types';

beforeEach(() =>
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_: string, _options: unknown, work: (lock: object) => unknown) =>
        (work ?? (_options as (lock: object) => unknown))({}),
    },
  }),
);
afterEach(() => vi.unstubAllGlobals());
test('submit distinguishes a local persistence failure from network and model failures', async () => {
  const store = new Store(crypto.randomUUID());
  const host = new RuntimeHost(store, new URL('https://app.test/'), () => {}, { connections: {} });
  const ask = (data: Record<string, unknown>) =>
    new Promise<HostReply>((resolve, reject) => {
      void host.handle({ ...data, protocol: protocolVersion }, resolve).catch(reject);
    });
  const chat = (await ask({ op: 'create' })).result as Conversation;
  const write = vi.spyOn(store, 'updateMany').mockRejectedValueOnce(new Error('disk full'));
  const failed = await ask({ op: 'submit', id: chat.id, text: 'hello' });
  expect(failed).toMatchObject({ ok: false, error: 'disk full', failureKind: 'app' });
  expect(failureKind(new OperationFailure(failed.error, failed.failureKind))).toBe('app');
  write.mockRestore();
  for (const [error, kind] of [
    [new ConnectionError('offline'), 'network'],
    [new ModelRejected('rejected'), 'model'],
  ] as const) {
    const submit = vi.spyOn(host.runtime, 'submit').mockRejectedValueOnce(error);
    expect(await ask({ op: 'submit', id: chat.id, text: '/compact' })).toMatchObject({
      ok: false,
      failureKind: kind,
    });
    expect(failureKind(new OperationFailure(error.message, kind))).toBe(kind);
    submit.mockRestore();
  }
});
