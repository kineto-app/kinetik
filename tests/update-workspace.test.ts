import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { NativeStore } from '../src/platform/secure-store';
import { exportArchive } from '../src/core/archive';
import { restoreUpdateSnapshot } from '../src/platform/updates';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/browser/client', () => ({ rpc: vi.fn() }));
let stagedReady: boolean;
let snapshot: string;
let recoveryName: string;
const store = () => new NativeStore();
beforeEach(async () => {
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', {
    locks: {
      request: (name: string, callback: () => unknown) => {
        const work = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(callback);
        tails.set(name, work);
        return work;
      },
    },
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  await new Store().replace([], () => false);
  stagedReady = false;
  snapshot = '';
  recoveryName = 'kinetik-update-recovery-' + crypto.randomUUID();
  mocks.invoke.mockReset().mockImplementation(async (command: string, payload: any) => {
    if (command === 'updates_workspace_write') {
      stagedReady = false;
      return true;
    }
    if (command === 'updates_restore') return payload.complete ? null : snapshot;
    if (command === 'updates_recovery_copy') return recoveryName;
  });
});
afterEach(() => vi.unstubAllGlobals());
async function note(text: string) {
  await store().put('filesystem', {
    revision: crypto.randomUUID(),
    entries: [
      { path: '/workspace', kind: 'directory', mode: 493, mtime: new Date() },
      {
        path: '/workspace/note.txt',
        kind: 'file',
        mode: 420,
        mtime: new Date(),
        bytes: new TextEncoder().encode(text),
      },
    ],
  });
}
test('workspace writes invalidate a staged snapshot before pre-update work changes', async () => {
  await note('at staging');
  snapshot = await exportArchive(store());
  stagedReady = true;
  await note('work written days later, before activation');
  expect(stagedReady).toBe(false);
  snapshot = await exportArchive(store());
  stagedReady = true;
  await note('failed new code changed the workspace');
  await restoreUpdateSnapshot();
  expect(await exportArchive(store())).toContain(
    btoa('work written days later, before activation'),
  );
});
test('rollback preserves outgoing raw records before replacing the workspace', async () => {
  await note('before activation');
  snapshot = await exportArchive(store());
  const outgoing = { format: 99, bytes: new Uint8Array([0, 255]), at: new Date() };
  await store().put('future-record', outgoing);
  await restoreUpdateSnapshot();
  expect(await store().get('future-record')).toBeUndefined();
  expect(await new Store(recoveryName).get('future-record')).toEqual(outgoing);
});

test('snapshot acknowledgement excludes concurrent writes and invalidation failure blocks mutation', async () => {
  const { withWorkspaceSnapshot } = await import('../src/platform/update-workspace');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const exporting = withWorkspaceSnapshot(async () => {
    started();
    await held;
    stagedReady = true;
  });
  await entered;
  const writing = store().put('test-write', 'new');
  expect(await new Store().get('test-write')).toBeUndefined();
  release();
  await exporting;
  await writing;
  expect(stagedReady).toBe(false);
  expect(await new Store().get('test-write')).toBe('new');
  mocks.invoke.mockRejectedValueOnce(new Error('cannot invalidate'));
  await expect(store().put('test-write', 'lost')).rejects.toThrow('cannot invalidate');
  expect(await new Store().get('test-write')).toBe('new');
});
test('failed recovery copy leaves live data untouched and restore retries preserve the original copy', async () => {
  await note('before switch');
  snapshot = await exportArchive(store());
  await store().put('future-record', 'outgoing');
  const replace = vi
    .spyOn(Store.prototype, 'replace')
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(restoreUpdateSnapshot()).rejects.toThrow('disk full');
  expect(await store().get('future-record')).toBe('outgoing');
  expect(mocks.invoke).not.toHaveBeenCalledWith('updates_restore', { complete: true });
  replace.mockRestore();
  await restoreUpdateSnapshot();
  await store().put('future-record', 'after retry');
  await restoreUpdateSnapshot();
  expect(await new Store(recoveryName).get('future-record')).toBe('outgoing');
});

test('snapshot capture reads current storage without initializing a runtime and waits for busy work', async () => {
  const { captureUpdateSnapshot } = await import('../src/platform/update-workspace');
  await note('current data');
  await store().put('conversation:busy', { status: 'running' });
  await expect(captureUpdateSnapshot('2.0.0')).rejects.toThrow('Wait for current work');
  expect(mocks.invoke).not.toHaveBeenCalledWith('updates_snapshot', expect.anything());
  await store().delete('conversation:busy');
  await captureUpdateSnapshot('2.0.0');
  expect(mocks.invoke).toHaveBeenCalledWith('updates_snapshot', {
    version: '2.0.0',
    text: expect.stringContaining(btoa('current data')),
  });
});
