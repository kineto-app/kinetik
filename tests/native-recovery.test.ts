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
