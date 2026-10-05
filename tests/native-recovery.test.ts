import { expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), show: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, addPluginListener: vi.fn() }));
vi.mock('../src/platform/update-recovery', () => ({ showUpdateRecovery: mocks.show }));
import { connectNative } from '../src/platform/native';

test('embedded recovery reports the problem without opening or migrating workspace storage', async () => {
  mocks.invoke.mockResolvedValue({
    recovery: 'Saved update state needs recovery. Your workspace has been kept.',
  });
  const open = vi.spyOn(indexedDB, 'open');
  try {
    await expect(connectNative()).rejects.toThrow('Saved update state needs recovery');
    expect(open).not.toHaveBeenCalled();
    expect(mocks.show).toHaveBeenCalledWith(
      expect.objectContaining({ recovery: expect.stringContaining('Saved update state') }),
    );
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('updates_status');
  } finally {
    open.mockRestore();
  }
});

test('replacement code finishes an interrupted restore before initializing the runtime', async () => {
  const { Store } = await import('../src/browser/store');
  const { exportArchive } = await import('../src/core/archive');
  const { RuntimeHost } = await import('../src/core/host');
  const store = new Store();
  await store.replace([], () => false);
  const snapshot = await exportArchive(store);
  await store.put('future-record', 'original outgoing data');
  const backupName = 'kinetik-update-recovery-' + crypto.randomUUID();
  let acknowledgements = 0;
  mocks.invoke
    .mockReset()
    .mockImplementation(async (command: string, args?: { complete?: boolean }) => {
      if (command === 'updates_status') return { enabled: true };
      if (command === 'updates_restore') {
        if (!args?.complete) return snapshot;
        if (++acknowledgements === 1) throw new Error('interrupted before acknowledgement');
        return null;
      }
      if (command === 'updates_recovery_copy') return backupName;
      if (command === 'updates_workspace_write') return false;
      throw new Error('Unexpected command: ' + command);
    });
  const initialize = vi.spyOn(RuntimeHost.prototype, 'initialize').mockImplementation(async () => {
    expect(acknowledgements).toBe(2);
    expect(await store.get('future-record')).toBeUndefined();
    expect(await new Store(backupName).get('future-record')).toBe('original outgoing data');
    // Stop before registering background listeners.
    throw new Error('runtime reached after restore');
  });
  vi.stubGlobal('__NATIVE_CONFIG__', { connections: {} });
  vi.stubGlobal('document', { baseURI: 'https://example.com/' });
  vi.stubGlobal('navigator', {
    userAgent: '',
    locks: { request: (_name: string, work: () => unknown) => work() },
  });
  const originalFetch = globalThis.fetch;
  try {
    // The first launch restores data but cannot acknowledge it. Runtime must stay stopped.
    await expect(connectNative()).rejects.toThrow('interrupted before acknowledgement');
    expect(initialize).not.toHaveBeenCalled();
    await store.put('future-record', 'partial retry data');
    await expect(connectNative()).rejects.toThrow('runtime reached after restore');
    expect(initialize).toHaveBeenCalledOnce();
  } finally {
    initialize.mockRestore();
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  }
});
